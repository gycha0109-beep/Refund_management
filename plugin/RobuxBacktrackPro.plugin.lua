local HttpService = game:GetService("HttpService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local ServerScriptService = game:GetService("ServerScriptService")

local VERSION = "0.4.0-alpha.2"
local ROOT_NAME = "RobuxBacktrackPro"
local RUNTIME_NAME = "RobuxBacktrackServer"
local HANDLERS_NAME = "ProductHandlers"
local BOOTSTRAP_NAME = "Bootstrap"

local BASE_URL_SETTING = "RobuxBacktrackProBaseUrl"
local SECRET_NAME_SETTING = "RobuxBacktrackProSecretName"

local DEFAULT_SECRET_NAME = "RobuxBacktrackActionKey"

local RUNTIME_SOURCE = [==[
local DataStoreService = game:GetService("DataStoreService")
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

if RunService:IsClient() then
	error("RobuxBacktrackServer must only be required from a server Script")
end

local Backtrack = {}

local DEFAULTS = {
	PollIntervalSeconds = 15,
	JitterSeconds = 5,
	LeaseSeconds = 60,
	MaxActionsPerPoll = 10,
	SecretName = "RobuxBacktrackActionKey",
	DataStoreName = "RobuxBacktrackProV1",
}

local config = nil
local actionSecret = nil
local markerStore = nil
local running = false
local handlers = {}

local function copyTable(source)
	local target = {}
	for key, value in pairs(source) do
		target[key] = value
	end
	return target
end

local function normalizeBaseUrl(value)
	assert(type(value) == "string" and value ~= "", "BaseUrl is required")
	return string.gsub(value, "/+$", "")
end

local function markerKey(actionId)
	local text = tostring(actionId)
	local hash = 5381

	for index = 1, #text do
		hash = (hash * 33 + string.byte(text, index)) % 4294967296
	end

	local prefix = string.gsub(text, "[^%w%-_]", "_")
	prefix = string.sub(prefix, 1, 24)

	return string.format("RB_%s_%08x", prefix, hash)
end

local function request(method, path, body)
	assert(config ~= nil, "Call Backtrack.Configure() first")
	assert(actionSecret ~= nil, "Backtrack action secret is not loaded")

	local requestOptions = {
		Url = config.BaseUrl .. path,
		Method = method,
		Headers = {
			["Content-Type"] = "application/json",
			["x-action-api-key"] = actionSecret,
		},
	}

	if body ~= nil then
		requestOptions.Body = HttpService:JSONEncode(body)
	end

	local ok, responseOrError = pcall(function()
		return HttpService:RequestAsync(requestOptions)
	end)

	if not ok then
		return nil, "http_request_failed: " .. tostring(responseOrError), nil
	end

	local response = responseOrError
	local decoded = nil

	if response.Body and response.Body ~= "" then
		local decodeOk, result = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if decodeOk then
			decoded = result
		end
	end

	if not response.Success then
		local apiError = decoded and decoded.error or response.StatusMessage
		return nil, tostring(apiError or "http_error"), response.StatusCode
	end

	return decoded or {}, nil, response.StatusCode
end

local function postAction(actionId, operation, body)
	local encodedActionId = HttpService:UrlEncode(tostring(actionId))
	return request("POST", "/api/actions/" .. encodedActionId .. "/" .. operation, body or {})
end

local function failRemote(action, reason)
	local _, errorMessage = postAction(action.ActionId, "fail", {
		leaseToken = action.LeaseToken,
		error = tostring(reason),
	})

	if errorMessage then
		warn("[Robux Backtrack] failed to report action failure:", errorMessage)
	end
end

local function completeRemote(action)
	local _, errorMessage = postAction(action.ActionId, "complete", {
		leaseToken = action.LeaseToken,
	})

	if errorMessage then
		warn("[Robux Backtrack] completion acknowledgement failed; lease recovery will retry:", errorMessage)
		return false
	end

	return true
end

local function acquireLocalMarker(action)
	local key = markerKey(action.ActionId)
	local runToken = HttpService:GenerateGUID(false)
	local savedMarker

	local ok, errorMessage = pcall(function()
		savedMarker = markerStore:UpdateAsync(key, function(current)
			if current ~= nil then
				return current
			end

			return {
				Status = "STARTED",
				ActionId = tostring(action.ActionId),
				NotificationId = tostring(action.NotificationId or action.ActionId),
				ProductId = action.ProductId,
				UserId = action.UserId,
				RunToken = runToken,
				StartedAt = os.time(),
				ServerJobId = game.JobId,
			}
		end)
	end)

	if not ok then
		return nil, "marker_acquire_failed: " .. tostring(errorMessage)
	end

	if savedMarker == nil then
		return nil, "marker_acquire_returned_nil"
	end

	if tostring(savedMarker.ActionId) ~= tostring(action.ActionId) then
		return nil, "marker_key_collision_manual_review"
	end

	if savedMarker.Status == "APPLIED" then
		return {
			State = "ALREADY_APPLIED",
			Key = key,
			Marker = savedMarker,
		}, nil
	end

	if savedMarker.RunToken ~= runToken then
		return {
			State = "ALREADY_STARTED",
			Key = key,
			Marker = savedMarker,
		}, nil
	end

	return {
		State = "ACQUIRED",
		Key = key,
		RunToken = runToken,
		Marker = savedMarker,
	}, nil
end

local function finishLocalMarker(markerKeyValue, runToken, status, detail)
	local savedMarker

	local ok, errorMessage = pcall(function()
		savedMarker = markerStore:UpdateAsync(markerKeyValue, function(current)
			if current == nil then
				return nil
			end

			if current.RunToken ~= runToken or current.Status ~= "STARTED" then
				return current
			end

			local nextValue = copyTable(current)
			nextValue.Status = status
			nextValue.FinishedAt = os.time()

			if detail ~= nil then
				nextValue.Detail = string.sub(tostring(detail), 1, 500)
			end

			return nextValue
		end)
	end)

	if not ok then
		return false, "marker_finish_failed: " .. tostring(errorMessage)
	end

	if savedMarker == nil or savedMarker.RunToken ~= runToken or savedMarker.Status ~= status then
		return false, "marker_finish_state_mismatch"
	end

	return true, nil
end

local function handlerFor(action)
	return handlers[tostring(action.ProductId)]
end

local function processAction(candidate)
	local claimPayload, claimError, claimStatus = postAction(candidate.ActionId, "claim", {
		leaseSeconds = config.LeaseSeconds,
	})

	if claimError then
		if claimStatus ~= 409 then
			warn("[Robux Backtrack] claim failed:", candidate.ActionId, claimError)
		end
		return false
	end

	local action = claimPayload.action
	if action == nil then
		warn("[Robux Backtrack] claim response did not include action")
		return false
	end

	local handler = handlerFor(action)
	if handler == nil then
		failRemote(action, "no_handler_for_product_" .. tostring(action.ProductId))
		return false
	end

	local localState, markerError = acquireLocalMarker(action)
	if localState == nil then
		failRemote(action, markerError)
		return false
	end

	if localState.State == "ALREADY_APPLIED" then
		return completeRemote(action)
	end

	if localState.State ~= "ACQUIRED" then
		local priorStatus = localState.Marker and localState.Marker.Status or "UNKNOWN"
		failRemote(action, "local_" .. tostring(priorStatus) .. "_manual_review")
		return false
	end

	local context = {
		ActionId = action.ActionId,
		NotificationId = action.NotificationId,
		TransactionId = action.TransactionId,
		UserId = action.UserId,
		ProductId = action.ProductId,
		RobuxAmount = action.RobuxAmount,
		Attempt = action.Attempt,
	}

	local handlerCall = table.pack(pcall(handler, context))
	local handlerSucceeded = handlerCall[1] and handlerCall[2] ~= false
	local handlerDetail = nil

	if not handlerCall[1] then
		handlerDetail = handlerCall[2]
	elseif handlerCall[2] == false then
		handlerDetail = handlerCall[3] or "handler_returned_false"
	end

	if not handlerSucceeded then
		local markerOk, markerFinishError = finishLocalMarker(
			localState.Key,
			localState.RunToken,
			"FAILED",
			handlerDetail
		)

		if not markerOk then
			handlerDetail = tostring(handlerDetail) .. "; " .. tostring(markerFinishError)
		end

		failRemote(action, handlerDetail)
		return false
	end

	local markerOk, markerFinishError = finishLocalMarker(
		localState.Key,
		localState.RunToken,
		"APPLIED",
		nil
	)

	if not markerOk then
		failRemote(action, markerFinishError .. "_manual_review")
		return false
	end

	return completeRemote(action)
end

function Backtrack.Configure(options)
	assert(not running, "Stop Robux Backtrack before reconfiguring")
	assert(type(options) == "table", "Configure expects a table")

	config = {
		BaseUrl = normalizeBaseUrl(options.BaseUrl),
		PollIntervalSeconds = tonumber(options.PollIntervalSeconds) or DEFAULTS.PollIntervalSeconds,
		JitterSeconds = tonumber(options.JitterSeconds) or DEFAULTS.JitterSeconds,
		LeaseSeconds = tonumber(options.LeaseSeconds) or DEFAULTS.LeaseSeconds,
		MaxActionsPerPoll = tonumber(options.MaxActionsPerPoll) or DEFAULTS.MaxActionsPerPoll,
		SecretName = options.SecretName or DEFAULTS.SecretName,
		DataStoreName = options.DataStoreName or DEFAULTS.DataStoreName,
	}

	assert(config.PollIntervalSeconds >= 5, "PollIntervalSeconds must be at least 5")
	assert(config.JitterSeconds >= 0, "JitterSeconds must be non-negative")
	assert(config.LeaseSeconds >= 15 and config.LeaseSeconds <= 300, "LeaseSeconds must be between 15 and 300")
	assert(config.MaxActionsPerPoll >= 1 and config.MaxActionsPerPoll <= 100, "MaxActionsPerPoll must be 1..100")

	actionSecret = HttpService:GetSecret(config.SecretName)
	markerStore = DataStoreService:GetDataStore(config.DataStoreName)
end

function Backtrack.RegisterProduct(productId, handler)
	assert(type(handler) == "function", "handler must be a function")
	handlers[tostring(productId)] = handler
end

function Backtrack.ProcessOnce()
	assert(config ~= nil, "Call Backtrack.Configure() first")

	local payload, errorMessage = request(
		"GET",
		"/api/actions?claimable=true&limit=" .. tostring(config.MaxActionsPerPoll),
		nil
	)

	if payload == nil then
		warn("[Robux Backtrack] queue poll failed:", errorMessage)
		return false, 0
	end

	local actions = payload.actions or {}
	local processed = 0

	for _, action in ipairs(actions) do
		if processAction(action) then
			processed += 1
		end
	end

	return true, processed
end

function Backtrack.Start()
	assert(config ~= nil, "Call Backtrack.Configure() first")
	if running then
		return
	end

	running = true

	task.spawn(function()
		while running do
			Backtrack.ProcessOnce()

			local jitter = 0
			if config.JitterSeconds > 0 then
				jitter = math.random() * config.JitterSeconds
			end

			task.wait(config.PollIntervalSeconds + jitter)
		end
	end)
end

function Backtrack.Stop()
	running = false
end

return Backtrack

]==]

local COLORS = {
	background = Color3.fromRGB(28, 29, 34),
	panel = Color3.fromRGB(37, 39, 46),
	input = Color3.fromRGB(45, 47, 55),
	button = Color3.fromRGB(58, 61, 70),
	text = Color3.fromRGB(242, 243, 246),
	muted = Color3.fromRGB(174, 178, 188),
	success = Color3.fromRGB(101, 210, 142),
	warning = Color3.fromRGB(242, 188, 91),
	error = Color3.fromRGB(242, 108, 108),
}

local function trim(value)
	return tostring(value or ""):gsub("%s+$", ""):gsub("^%s+", "")
end

local function normalizeBaseUrl(value)
	return trim(value):gsub("/+$", "")
end

local function setSource(container, source)
	local ok, errorMessage = pcall(function()
		ScriptEditorService:UpdateSourceAsync(container, function()
			return source
		end)
	end)

	if not ok then
		return false, tostring(errorMessage)
	end

	return true
end

local function getEditorSource(container)
	local ok, result = pcall(function()
		return ScriptEditorService:GetEditorSource(container)
	end)

	if ok then
		return result
	end

	return container.Source
end

local function makeHandlersSource()
	return [[-- Robux Backtrack Pro product refund handlers.
-- Add handlers through the Pro plugin or edit them directly.
-- Returning false, "reason" marks the action FAILED and prevents silent success.

local handlers = {
	-- ROBUX_BACKTRACK_HANDLERS_START
	-- ROBUX_BACKTRACK_HANDLERS_END
}

return handlers
]]
end

local function escapeLuaString(value)
	return string.format("%q", tostring(value))
end

local function makeBootstrapSource(baseUrl, secretName)
	return string.format([[-- Managed by Robux Backtrack Pro.
-- Backend URL is configuration, not a credential.
-- The ACTION_API_KEY value must stay in Roblox Secrets Store.

local Backtrack = require(script.Parent.%s)
local handlers = require(script.Parent.%s)

Backtrack.Configure({
	BaseUrl = %s,
	SecretName = %s,
})

for productId, handler in pairs(handlers) do
	Backtrack.RegisterProduct(productId, handler)
end

Backtrack.Start()
]], RUNTIME_NAME, HANDLERS_NAME, escapeLuaString(baseUrl), escapeLuaString(secretName))
end

local function managedInstance(parent, name, className)
	local existing = parent:FindFirstChild(name)
	if existing then
		if existing.ClassName ~= className then
			return nil, string.format("%s exists but is %s, expected %s", name, existing.ClassName, className)
		end
		return existing, nil
	end

	local instance = Instance.new(className)
	instance.Name = name
	instance:SetAttribute("RobuxBacktrackManaged", true)
	instance:SetAttribute("RobuxBacktrackVersion", VERSION)
	instance.Parent = parent
	return instance, nil
end

local function findRoot()
	local root = ServerScriptService:FindFirstChild(ROOT_NAME)
	if root and not root:IsA("Folder") then
		return nil
	end
	return root
end

local function getOrCreateRoot()
	local root = findRoot()
	if root then
		return root, nil
	end

	if ServerScriptService:FindFirstChild(ROOT_NAME) then
		return nil, ROOT_NAME .. " already exists and is not a Folder"
	end

	root = Instance.new("Folder")
	root.Name = ROOT_NAME
	root:SetAttribute("RobuxBacktrackManaged", true)
	root:SetAttribute("RobuxBacktrackVersion", VERSION)
	root.Parent = ServerScriptService
	return root, nil
end

local toolbar = plugin:CreateToolbar("Robux Backtrack Pro")
local openButton = toolbar:CreateButton(
	"RobuxBacktrackProOpen",
	"Open Robux Backtrack Pro",
	"",
	"Robux Backtrack Pro"
)
openButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right,
	false,
	false,
	460,
	680,
	380,
	480
)

local widget = plugin:CreateDockWidgetPluginGuiAsync("RobuxBacktrackProV1", widgetInfo)
widget.Title = "Robux Backtrack Pro"

local rootUi = Instance.new("ScrollingFrame")
rootUi.Name = "Root"
rootUi.Size = UDim2.fromScale(1, 1)
rootUi.BackgroundColor3 = COLORS.background
rootUi.BorderSizePixel = 0
rootUi.ScrollBarThickness = 6
rootUi.AutomaticCanvasSize = Enum.AutomaticSize.Y
rootUi.CanvasSize = UDim2.new()
rootUi.Parent = widget

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 12)
padding.PaddingBottom = UDim.new(0, 12)
padding.PaddingLeft = UDim.new(0, 12)
padding.PaddingRight = UDim.new(0, 12)
padding.Parent = rootUi

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = rootUi

local function makeLabel(order, text, height, muted)
	local label = Instance.new("TextLabel")
	label.LayoutOrder = order
	label.Size = UDim2.new(1, 0, 0, height or 22)
	label.BackgroundTransparency = 1
	label.Text = text
	label.TextWrapped = true
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextYAlignment = Enum.TextYAlignment.Top
	label.TextColor3 = muted and COLORS.muted or COLORS.text
	label.Font = Enum.Font.SourceSansSemibold
	label.TextSize = muted and 13 or 16
	label.Parent = rootUi
	return label
end

local function makeTextBox(order, placeholder, value)
	local box = Instance.new("TextBox")
	box.LayoutOrder = order
	box.Size = UDim2.new(1, 0, 0, 34)
	box.BackgroundColor3 = COLORS.input
	box.BorderSizePixel = 0
	box.TextColor3 = COLORS.text
	box.PlaceholderColor3 = COLORS.muted
	box.PlaceholderText = placeholder
	box.ClearTextOnFocus = false
	box.TextXAlignment = Enum.TextXAlignment.Left
	box.TextSize = 14
	box.Text = value or ""
	box.Parent = rootUi

	local boxPadding = Instance.new("UIPadding")
	boxPadding.PaddingLeft = UDim.new(0, 8)
	boxPadding.PaddingRight = UDim.new(0, 8)
	boxPadding.Parent = box

	return box
end

local function makeButton(parent, text, position, size)
	local button = Instance.new("TextButton")
	button.Position = position
	button.Size = size
	button.BackgroundColor3 = COLORS.button
	button.BorderSizePixel = 0
	button.Text = text
	button.TextColor3 = COLORS.text
	button.TextSize = 14
	button.Parent = parent
	return button
end

makeLabel(1, "Robux Backtrack Pro", 26)
makeLabel(
	2,
	"Install the server runtime, register Developer Product handlers, and verify the Pro backend without storing ACTION_API_KEY in plugin source.",
	48,
	true
)

makeLabel(3, "Backend URL")
local baseUrlBox = makeTextBox(
	4,
	"https://your-backend.example.com",
	plugin:GetSetting(BASE_URL_SETTING) or ""
)

makeLabel(5, "Roblox secret name")
local secretNameBox = makeTextBox(
	6,
	DEFAULT_SECRET_NAME,
	plugin:GetSetting(SECRET_NAME_SETTING) or DEFAULT_SECRET_NAME
)

local configControls = Instance.new("Frame")
configControls.LayoutOrder = 7
configControls.Size = UDim2.new(1, 0, 0, 34)
configControls.BackgroundTransparency = 1
configControls.Parent = rootUi

local saveButton = makeButton(
	configControls,
	"Save config",
	UDim2.new(0, 0, 0, 0),
	UDim2.new(0.32, -4, 1, 0)
)
local testButton = makeButton(
	configControls,
	"Test backend",
	UDim2.new(0.32, 4, 0, 0),
	UDim2.new(0.34, -8, 1, 0)
)
local installButton = makeButton(
	configControls,
	"Install runtime",
	UDim2.new(0.66, 4, 0, 0),
	UDim2.new(0.34, -4, 1, 0)
)

makeLabel(8, "Product handler", 22)
local productIdBox = makeTextBox(9, "Developer Product ID", "")

local handlerControls = Instance.new("Frame")
handlerControls.LayoutOrder = 10
handlerControls.Size = UDim2.new(1, 0, 0, 34)
handlerControls.BackgroundTransparency = 1
handlerControls.Parent = rootUi

local addProductButton = makeButton(
	handlerControls,
	"Add product",
	UDim2.new(0, 0, 0, 0),
	UDim2.new(0.32, -4, 1, 0)
)
local openHandlersButton = makeButton(
	handlerControls,
	"Open handlers",
	UDim2.new(0.32, 4, 0, 0),
	UDim2.new(0.34, -8, 1, 0)
)
local validateButton = makeButton(
	handlerControls,
	"Validate setup",
	UDim2.new(0.66, 4, 0, 0),
	UDim2.new(0.34, -4, 1, 0)
)

local statusLabel = makeLabel(
	11,
	"Configure your backend URL, create the ACTION_API_KEY value in Roblox Secrets Store, then install the runtime.",
	62,
	true
)

local readinessLabel = makeLabel(12, "Readiness", 22)
local readinessBox = Instance.new("TextLabel")
readinessBox.LayoutOrder = 13
readinessBox.Size = UDim2.new(1, 0, 0, 150)
readinessBox.BackgroundColor3 = COLORS.panel
readinessBox.BorderSizePixel = 0
readinessBox.TextColor3 = COLORS.text
readinessBox.TextXAlignment = Enum.TextXAlignment.Left
readinessBox.TextYAlignment = Enum.TextYAlignment.Top
readinessBox.TextWrapped = true
readinessBox.Font = Enum.Font.Code
readinessBox.TextSize = 13
readinessBox.Text = "Runtime: not checked\nBackend: not checked\nHandlers: not checked"
readinessBox.Parent = rootUi

local readinessPadding = Instance.new("UIPadding")
readinessPadding.PaddingTop = UDim.new(0, 10)
readinessPadding.PaddingBottom = UDim.new(0, 10)
readinessPadding.PaddingLeft = UDim.new(0, 10)
readinessPadding.PaddingRight = UDim.new(0, 10)
readinessPadding.Parent = readinessBox

local function setStatus(text, kind)
	statusLabel.Text = text

	if kind == "success" then
		statusLabel.TextColor3 = COLORS.success
	elseif kind == "warning" then
		statusLabel.TextColor3 = COLORS.warning
	elseif kind == "error" then
		statusLabel.TextColor3 = COLORS.error
	else
		statusLabel.TextColor3 = COLORS.muted
	end
end

local function currentConfig()
	local baseUrl = normalizeBaseUrl(baseUrlBox.Text)
	local secretName = trim(secretNameBox.Text)
	if secretName == "" then
		secretName = DEFAULT_SECRET_NAME
	end
	return baseUrl, secretName
end

local function requestHealth()
	local baseUrl = normalizeBaseUrl(baseUrlBox.Text)
	if baseUrl == "" then
		return nil, "missing_url"
	end

	local ok, responseOrError = pcall(function()
		return HttpService:RequestAsync({
			Url = baseUrl .. "/health",
			Method = "GET",
		})
	end)

	if not ok then
		return nil, "network_error", tostring(responseOrError)
	end

	local response = responseOrError
	if not response.Success then
		return nil, "http_error", tostring(response.StatusCode)
	end

	local decodedOk, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodedOk then
		return nil, "invalid_response"
	end

	return decoded
end

local function testBackend()
	setStatus("Testing Pro backend...", "neutral")

	local health, reason, detail = requestHealth()
	if not health then
		if reason == "missing_url" then
			setStatus("Enter the backend URL first.", "warning")
		elseif reason == "network_error" then
			setStatus("Cannot reach backend. Studio may ask for permission to access this domain. " .. tostring(detail or ""), "error")
		else
			setStatus("Backend health check failed: " .. tostring(detail or reason), "error")
		end
		return nil
	end

	if health.actionApiKeyConfigured ~= true then
		setStatus("Backend reachable, but ACTION_API_KEY is not configured there yet.", "warning")
		return health
	end

	if health.actionStoragePersistent ~= true then
		setStatus("Backend reachable, but Pro action storage is not persistent.", "warning")
		return health
	end

	setStatus("Pro backend is reachable and action API/storage are configured.", "success")
	return health
end

local function installRuntime()
	local baseUrl, secretName = currentConfig()
	if baseUrl == "" then
		setStatus("Enter the backend URL before installing.", "warning")
		return false
	end

	plugin:SetSetting(BASE_URL_SETTING, baseUrl)
	plugin:SetSetting(SECRET_NAME_SETTING, secretName)

	local root, rootError = getOrCreateRoot()
	if not root then
		setStatus(rootError, "error")
		return false
	end

	local runtime, runtimeError = managedInstance(root, RUNTIME_NAME, "ModuleScript")
	if not runtime then
		setStatus(runtimeError, "error")
		return false
	end

	if runtime:GetAttribute("RobuxBacktrackManaged") ~= true then
		setStatus("Existing RobuxBacktrackServer is not plugin-managed; refusing to overwrite it.", "error")
		return false
	end

	local runtimeOk, runtimeWriteError = setSource(runtime, RUNTIME_SOURCE)
	if not runtimeOk then
		setStatus("Could not write runtime source: " .. runtimeWriteError, "error")
		return false
	end
	runtime:SetAttribute("RobuxBacktrackManaged", true)
	runtime:SetAttribute("RobuxBacktrackVersion", VERSION)

	local handlers, handlersError = managedInstance(root, HANDLERS_NAME, "ModuleScript")
	if not handlers then
		setStatus(handlersError, "error")
		return false
	end

	local handlersSource = getEditorSource(handlers)
	if trim(handlersSource) == "" then
		local handlersOk, handlersWriteError = setSource(handlers, makeHandlersSource())
		if not handlersOk then
			setStatus("Could not create ProductHandlers: " .. handlersWriteError, "error")
			return false
		end
	elseif not handlersSource:find("ROBUX_BACKTRACK_HANDLERS_START", 1, true) then
		setStatus("Existing ProductHandlers has no Backtrack markers; refusing to overwrite developer code.", "error")
		return false
	end

	local bootstrap, bootstrapError = managedInstance(root, BOOTSTRAP_NAME, "Script")
	if not bootstrap then
		setStatus(bootstrapError, "error")
		return false
	end

	if bootstrap:GetAttribute("RobuxBacktrackManaged") ~= true then
		setStatus("Existing Bootstrap is not plugin-managed; refusing to overwrite it.", "error")
		return false
	end

	local bootstrapOk, bootstrapWriteError = setSource(
		bootstrap,
		makeBootstrapSource(baseUrl, secretName)
	)
	if not bootstrapOk then
		setStatus("Could not write Bootstrap source: " .. bootstrapWriteError, "error")
		return false
	end

	bootstrap:SetAttribute("RobuxBacktrackManaged", true)
	bootstrap:SetAttribute("RobuxBacktrackVersion", VERSION)
	root:SetAttribute("RobuxBacktrackManaged", true)
	root:SetAttribute("RobuxBacktrackVersion", VERSION)

	setStatus("Pro runtime installed/updated. ProductHandlers was preserved.", "success")
	return true
end

local function getHandlers()
	local root = findRoot()
	if not root then
		return nil, "Runtime is not installed yet."
	end

	local handlers = root:FindFirstChild(HANDLERS_NAME)
	if not handlers or not handlers:IsA("ModuleScript") then
		return nil, "ProductHandlers ModuleScript is missing."
	end

	return handlers
end

local function addProduct()
	local productId = trim(productIdBox.Text)
	if not productId:match("^%d+$") then
		setStatus("Enter a numeric Developer Product ID.", "warning")
		return
	end

	local handlers, handlersError = getHandlers()
	if not handlers then
		setStatus(handlersError, "warning")
		return
	end

	local source = getEditorSource(handlers)
	if source:find("%[" .. productId .. "%]%s*=") then
		setStatus("Product " .. productId .. " already has a handler.", "warning")
		return
	end

	local marker = "\t-- ROBUX_BACKTRACK_HANDLERS_END"
	if not source:find(marker, 1, true) then
		setStatus("ProductHandlers markers are missing; refusing to edit it.", "error")
		return
	end

	local block = string.format([[
	[%s] = function(action)
		-- TODO: reverse this product's persistent reward for action.UserId.
		-- Keep this handler safe for an offline user.
		-- Return true only after your own durable game data update succeeds.
		return false, "handler_not_implemented"
	end,

]], productId)

	local nextSource = source:gsub(marker, block .. marker, 1)
	local ok, errorMessage = setSource(handlers, nextSource)
	if not ok then
		setStatus("Could not add product handler: " .. errorMessage, "error")
		return
	end

	productIdBox.Text = ""
	setStatus("Added Product " .. productId .. ". Open handlers and replace the safe TODO stub.", "success")

	pcall(function()
		ScriptEditorService:OpenScriptDocumentAsync(handlers)
	end)
end

local function openHandlers()
	local handlers, handlersError = getHandlers()
	if not handlers then
		setStatus(handlersError, "warning")
		return
	end

	local ok, opened, errorMessage = pcall(function()
		return ScriptEditorService:OpenScriptDocumentAsync(handlers)
	end)

	if not ok then
		setStatus("Could not open ProductHandlers: " .. tostring(opened), "error")
		return
	end

	if opened == false then
		setStatus("Could not open ProductHandlers: " .. tostring(errorMessage), "error")
		return
	end

	setStatus("ProductHandlers opened in the Script Editor.", "success")
end

local function handlerCount(source)
	local count = 0
	for _ in source:gmatch("%[%d+%]%s*=%s*function") do
		count += 1
	end
	return count
end

local function todoHandlerCount(source)
	local count = 0
	for _ in source:gmatch('return%s+false,%s*"handler_not_implemented"') do
		count += 1
	end
	return count
end

local function validateSetup()
	local lines = {}
	local problems = 0

	local baseUrl, secretName = currentConfig()
	if baseUrl == "" then
		table.insert(lines, "✗ Backend URL: missing")
		problems += 1
	else
		table.insert(lines, "✓ Backend URL: configured")
	end

	local root = findRoot()
	if not root then
		table.insert(lines, "✗ Runtime: not installed")
		problems += 1
	else
		local runtime = root:FindFirstChild(RUNTIME_NAME)
		local handlers = root:FindFirstChild(HANDLERS_NAME)
		local bootstrap = root:FindFirstChild(BOOTSTRAP_NAME)

		if runtime and runtime:IsA("ModuleScript") then
			table.insert(lines, "✓ Runtime: installed")
		else
			table.insert(lines, "✗ Runtime: missing")
			problems += 1
		end

		if bootstrap and bootstrap:IsA("Script") then
			table.insert(lines, "✓ Bootstrap: installed")
		else
			table.insert(lines, "✗ Bootstrap: missing")
			problems += 1
		end

		if handlers and handlers:IsA("ModuleScript") then
			local source = getEditorSource(handlers)
			local registered = handlerCount(source)
			local todos = todoHandlerCount(source)
			table.insert(lines, string.format("✓ Product handlers: %d registered", registered))

			if registered == 0 then
				table.insert(lines, "! Add at least one Developer Product handler")
				problems += 1
			elseif todos > 0 then
				table.insert(lines, string.format("! %d handler(s) still use safe TODO stubs", todos))
				problems += todos
			end
		else
			table.insert(lines, "✗ ProductHandlers: missing")
			problems += 1
		end
	end

	local health, reason = requestHealth()
	if health then
		if health.actionApiKeyConfigured == true then
			table.insert(lines, "✓ Backend ACTION_API_KEY: configured")
		else
			table.insert(lines, "✗ Backend ACTION_API_KEY: missing")
			problems += 1
		end

		if health.actionStoragePersistent == true then
			table.insert(lines, "✓ Action storage: persistent")
		else
			table.insert(lines, "✗ Action storage: not persistent")
			problems += 1
		end
	else
		table.insert(lines, "✗ Backend health: " .. tostring(reason))
		problems += 1
	end

	table.insert(lines, "! Experience HTTP Requests must be enabled")
	table.insert(lines, "! Roblox secret expected: " .. secretName)

	readinessBox.Text = table.concat(lines, "\n")
	readinessBox.Size = UDim2.new(1, 0, 0, math.max(150, 18 * #lines + 20))

	if problems == 0 then
		setStatus("Setup validation passed. Run a controlled test refund next.", "success")
	else
		setStatus(string.format("Setup validation found %d item(s) to fix.", problems), "warning")
	end
end

saveButton.MouseButton1Click:Connect(function()
	local baseUrl, secretName = currentConfig()
	plugin:SetSetting(BASE_URL_SETTING, baseUrl)
	plugin:SetSetting(SECRET_NAME_SETTING, secretName)
	setStatus("Configuration saved locally. No ACTION_API_KEY value is stored by this plugin.", "success")
end)

testButton.MouseButton1Click:Connect(testBackend)
installButton.MouseButton1Click:Connect(function()
	if installRuntime() then
		validateSetup()
	end
end)
addProductButton.MouseButton1Click:Connect(addProduct)
openHandlersButton.MouseButton1Click:Connect(openHandlers)
validateButton.MouseButton1Click:Connect(validateSetup)

openButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
	if widget.Enabled then
		validateSetup()
	end
end)
