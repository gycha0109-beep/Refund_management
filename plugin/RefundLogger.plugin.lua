local HttpService = game:GetService("HttpService")

local API_URL_SETTING = "RefundLoggerApiBaseUrl"
local API_KEY_SETTING = "RefundLoggerApiKey"
local DEFAULT_API = ""

local COLORS = {
    background = Color3.fromRGB(30, 30, 34),
    panel = Color3.fromRGB(38, 38, 44),
    input = Color3.fromRGB(45, 45, 50),
    button = Color3.fromRGB(55, 55, 62),
    text = Color3.fromRGB(240, 240, 245),
    muted = Color3.fromRGB(180, 180, 188),
    success = Color3.fromRGB(104, 211, 145),
    warning = Color3.fromRGB(246, 193, 119),
    error = Color3.fromRGB(245, 112, 112),
}

local toolbar = plugin:CreateToolbar("Refund Management")
local openButton = toolbar:CreateButton(
    "RefundLoggerOpen",
    "Open Refund Logger",
    "",
    "Refund Logger"
)
openButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
    Enum.InitialDockState.Right,
    false,
    false,
    440,
    620,
    340,
    420
)

local widget = plugin:CreateDockWidgetPluginGuiAsync("RefundManagementLoggerV2", widgetInfo)
widget.Title = "Refund Logger"

local root = Instance.new("ScrollingFrame")
root.Name = "Root"
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = COLORS.background
root.BorderSizePixel = 0
root.ScrollBarThickness = 6
root.ScrollingDirection = Enum.ScrollingDirection.Y
root.AutomaticCanvasSize = Enum.AutomaticSize.Y
root.CanvasSize = UDim2.new()
root.Parent = widget

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 12)
padding.PaddingBottom = UDim.new(0, 12)
padding.PaddingLeft = UDim.new(0, 12)
padding.PaddingRight = UDim.new(0, 12)
padding.Parent = root

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = root

local function makeLabel(order, text, height)
    local label = Instance.new("TextLabel")
    label.LayoutOrder = order
    label.Size = UDim2.new(1, 0, 0, height or 22)
    label.BackgroundTransparency = 1
    label.Text = text
    label.TextXAlignment = Enum.TextXAlignment.Left
    label.TextColor3 = COLORS.text
    label.Font = Enum.Font.SourceSansSemibold
    label.TextSize = 16
    label.Parent = root
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
    box.Parent = root

    local boxPadding = Instance.new("UIPadding")
    boxPadding.PaddingLeft = UDim.new(0, 8)
    boxPadding.PaddingRight = UDim.new(0, 8)
    boxPadding.Parent = box

    return box
end

makeLabel(1, "API base URL")
local endpointBox = makeTextBox(
    2,
    DEFAULT_API,
    plugin:GetSetting(API_URL_SETTING) or DEFAULT_API
)

makeLabel(3, "API key")
local apiKeyBox = makeTextBox(
    4,
    "Paste your refund-read API key",
    plugin:GetSetting(API_KEY_SETTING) or ""
)

local controls = Instance.new("Frame")
controls.LayoutOrder = 5
controls.Size = UDim2.new(1, 0, 0, 34)
controls.BackgroundTransparency = 1
controls.Parent = root

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

local saveButton = makeButton(
    controls,
    "Save",
    UDim2.new(0, 0, 0, 0),
    UDim2.new(0.32, -4, 1, 0)
)
local testButton = makeButton(
    controls,
    "Test",
    UDim2.new(0.32, 4, 0, 0),
    UDim2.new(0.34, -8, 1, 0)
)
local refreshButton = makeButton(
    controls,
    "Refresh",
    UDim2.new(0.66, 4, 0, 0),
    UDim2.new(0.34, -4, 1, 0)
)

local statusLabel = Instance.new("TextLabel")
statusLabel.LayoutOrder = 6
statusLabel.Size = UDim2.new(1, 0, 0, 42)
statusLabel.BackgroundTransparency = 1
statusLabel.Text = "First run — enter your backend URL and refund-read API key."
statusLabel.TextWrapped = true
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.TextYAlignment = Enum.TextYAlignment.Top
statusLabel.TextColor3 = COLORS.muted
statusLabel.TextSize = 14
statusLabel.Parent = root

local recentLabel = makeLabel(7, "Recent refunds")

local list = Instance.new("ScrollingFrame")
list.LayoutOrder = 8
list.Size = UDim2.new(1, 0, 0, 320)
list.BackgroundColor3 = Color3.fromRGB(24, 24, 28)
list.BorderSizePixel = 0
list.ScrollBarThickness = 6
list.AutomaticCanvasSize = Enum.AutomaticSize.Y
list.CanvasSize = UDim2.new()
list.Parent = root

local listPadding = Instance.new("UIPadding")
listPadding.PaddingTop = UDim.new(0, 8)
listPadding.PaddingBottom = UDim.new(0, 8)
listPadding.PaddingLeft = UDim.new(0, 8)
listPadding.PaddingRight = UDim.new(0, 8)
listPadding.Parent = list

local listLayout = Instance.new("UIListLayout")
listLayout.Padding = UDim.new(0, 8)
listLayout.SortOrder = Enum.SortOrder.LayoutOrder
listLayout.Parent = list

local function trim(value)
    return tostring(value or ""):gsub("%s+$", ""):gsub("^%s+", "")
end

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

local function clearRows()
    for _, child in list:GetChildren() do
        if child.Name == "RefundRow" then
            child:Destroy()
        end
    end
end

local function firstValue(payload, keys)
    for _, key in keys do
        local value = payload[key]
        if value ~= nil and tostring(value) ~= "" then
            return tostring(value)
        end
    end
    return nil
end

local function shortValue(value, maxLength)
    if value == nil then
        return nil
    end

    value = tostring(value)
    if #value <= maxLength then
        return value
    end

    return value:sub(1, maxLength - 3) .. "..."
end

local function buildRefundText(event)
    local payload = event.EventPayload or {}
    local userId = firstValue(payload, { "BuyerUserId", "UserId", "PlayerId" })
    local productType = firstValue(payload, { "ProductType", "AssetType" })
    local productId = firstValue(payload, { "ProductId", "AssetId" })
    local robux = firstValue(payload, { "RobuxAmount", "Robux", "Amount", "CurrencySpent" })
    local transactionId = firstValue(payload, { "TransactionId", "ReceiptId", "PurchaseId" })
    local refundedAt = firstValue(payload, { "RefundTime", "RefundedAt" }) or event.EventTime

    local lines = { "REFUNDED" }

    if userId then
        table.insert(lines, "User ID: " .. userId)
    end

    if productId then
        local product = "Product: "
        if productType then
            product ..= productType .. " "
        end
        product ..= "#" .. productId
        table.insert(lines, product)
    elseif productType then
        table.insert(lines, "Product: " .. productType)
    end

    if robux then
        table.insert(lines, "Robux: " .. robux)
    end

    if transactionId then
        table.insert(lines, "Transaction: " .. (shortValue(transactionId, 42) or ""))
    end

    if refundedAt then
        table.insert(lines, "Refunded: " .. tostring(refundedAt))
    end

    if event.NotificationId then
        table.insert(lines, "Notification: " .. (shortValue(event.NotificationId, 42) or ""))
    end

    if #lines == 1 then
        table.insert(lines, HttpService:JSONEncode(payload))
    end

    return table.concat(lines, "\n")
end

local function addRow(event, index)
    local row = Instance.new("Frame")
    row.Name = "RefundRow"
    row.LayoutOrder = index
    row.Size = UDim2.new(1, -4, 0, 132)
    row.BackgroundColor3 = COLORS.panel
    row.BorderSizePixel = 0
    row.Parent = list

    local rowPadding = Instance.new("UIPadding")
    rowPadding.PaddingTop = UDim.new(0, 10)
    rowPadding.PaddingBottom = UDim.new(0, 10)
    rowPadding.PaddingLeft = UDim.new(0, 10)
    rowPadding.PaddingRight = UDim.new(0, 10)
    rowPadding.Parent = row

    local text = Instance.new("TextLabel")
    text.Size = UDim2.new(1, 0, 1, 0)
    text.BackgroundTransparency = 1
    text.TextColor3 = COLORS.text
    text.TextXAlignment = Enum.TextXAlignment.Left
    text.TextYAlignment = Enum.TextYAlignment.Top
    text.TextWrapped = true
    text.Font = Enum.Font.Code
    text.TextSize = 13
    text.Text = buildRefundText(event)
    text.Parent = row
end

local function currentConfig()
    return trim(endpointBox.Text):gsub("/+$", ""), trim(apiKeyBox.Text)
end

local function requestRefunds(limit)
    local baseUrl, apiKey = currentConfig()

    if baseUrl == "" then
        return nil, "missing_url"
    end
    if apiKey == "" then
        return nil, "missing_api_key"
    end

    local ok, responseOrError = pcall(function()
        return HttpService:RequestAsync({
            Url = baseUrl .. "/api/refunds?limit=" .. tostring(limit or 20),
            Method = "GET",
            Headers = {
                ["x-refund-api-key"] = apiKey,
            },
        })
    end)

    if not ok then
        return nil, "network_error", tostring(responseOrError)
    end

    local response = responseOrError
    if response.StatusCode == 401 then
        return nil, "unauthorized"
    end
    if response.StatusCode == 503 then
        return nil, "server_unconfigured"
    end
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

local function showRequestError(reason, detail)
    if reason == "missing_url" then
        setStatus("Enter your Refund Logger backend URL first.", "warning")
    elseif reason == "missing_api_key" then
        setStatus("Enter your refund-read API key first.", "warning")
    elseif reason == "unauthorized" then
        setStatus("Server reachable — API key rejected.", "error")
    elseif reason == "server_unconfigured" then
        setStatus("Server reachable — REFUND_API_KEY is not configured on Railway.", "error")
    elseif reason == "network_error" then
        setStatus(
            "Cannot reach server. Studio may need permission for this domain. " .. tostring(detail or ""),
            "error"
        )
    elseif reason == "invalid_response" then
        setStatus("Server returned an invalid response.", "error")
    else
        setStatus("Server error: " .. tostring(detail or reason), "error")
    end
end

local function testConnection()
    setStatus("Testing connection...", "neutral")
    local result, reason, detail = requestRefunds(1)
    if not result then
        showRequestError(reason, detail)
        return
    end

    setStatus("Connected — API authentication succeeded.", "success")
end

local function refresh()
    setStatus("Loading refunds...", "neutral")

    local result, reason, detail = requestRefunds(20)
    if not result then
        clearRows()
        showRequestError(reason, detail)
        return
    end

    clearRows()
    local events = result.events or {}

    if #events == 0 then
        setStatus("Connected — no refund events yet.", "success")
        return
    end

    for index, event in ipairs(events) do
        addRow(event, index)
    end

    setStatus(string.format("Connected — %d refund event(s) loaded below.", #events), "success")
end

saveButton.MouseButton1Click:Connect(function()
    local baseUrl, apiKey = currentConfig()
    plugin:SetSetting(API_URL_SETTING, baseUrl)
    plugin:SetSetting(API_KEY_SETTING, apiKey)
    setStatus("Configuration saved locally in Studio. Click Test to verify it.", "success")
end)

testButton.MouseButton1Click:Connect(testConnection)
refreshButton.MouseButton1Click:Connect(refresh)

openButton.Click:Connect(function()
    widget.Enabled = not widget.Enabled
    if widget.Enabled then
        refresh()
    end
end)
