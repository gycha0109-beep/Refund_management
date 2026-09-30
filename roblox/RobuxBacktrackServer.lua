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

	if config.TestFault == "AFTER_HANDLER_BEFORE_COMPLETE" then
		warn("[Robux Backtrack][E2E] injected fault after handler and local APPLIED marker")
		return false
	end

	return completeRemote(action)
end

function Backtrack.Configure(options)
	assert(not running, "Stop Robux Backtrack before reconfiguring")
	assert(type(options) == "table", "Configure expects a table")

	local testFault = options.TestFault
	if testFault ~= nil then
		assert(RunService:IsStudio(), "TestFault is only allowed in Roblox Studio")
		assert(
			testFault == "AFTER_HANDLER_BEFORE_COMPLETE",
			"unsupported TestFault"
		)
	end

	config = {
		BaseUrl = normalizeBaseUrl(options.BaseUrl),
		PollIntervalSeconds = tonumber(options.PollIntervalSeconds) or DEFAULTS.PollIntervalSeconds,
		JitterSeconds = tonumber(options.JitterSeconds) or DEFAULTS.JitterSeconds,
		LeaseSeconds = tonumber(options.LeaseSeconds) or DEFAULTS.LeaseSeconds,
		MaxActionsPerPoll = tonumber(options.MaxActionsPerPoll) or DEFAULTS.MaxActionsPerPoll,
		SecretName = options.SecretName or DEFAULTS.SecretName,
		DataStoreName = options.DataStoreName or DEFAULTS.DataStoreName,
		TestFault = testFault,
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
