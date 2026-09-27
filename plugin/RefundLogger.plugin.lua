local HttpService = game:GetService("HttpService")

local SETTING_KEY = "RefundLoggerApiBaseUrl"
local DEFAULT_API = "http://localhost:8787"

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
    420,
    520,
    320,
    300
)

local widget = plugin:CreateDockWidgetPluginGuiAsync("RefundManagementLoggerV1", widgetInfo)
widget.Title = "Refund Logger"

local root = Instance.new("Frame")
root.Name = "Root"
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = Color3.fromRGB(30, 30, 34)
root.BorderSizePixel = 0
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

local endpointLabel = Instance.new("TextLabel")
endpointLabel.LayoutOrder = 1
endpointLabel.Size = UDim2.new(1, 0, 0, 22)
endpointLabel.BackgroundTransparency = 1
endpointLabel.Text = "API base URL"
endpointLabel.TextXAlignment = Enum.TextXAlignment.Left
endpointLabel.TextColor3 = Color3.fromRGB(230, 230, 235)
endpointLabel.Font = Enum.Font.SourceSansSemibold
endpointLabel.TextSize = 16
endpointLabel.Parent = root

local endpointBox = Instance.new("TextBox")
endpointBox.LayoutOrder = 2
endpointBox.Size = UDim2.new(1, 0, 0, 34)
endpointBox.BackgroundColor3 = Color3.fromRGB(45, 45, 50)
endpointBox.BorderSizePixel = 0
endpointBox.TextColor3 = Color3.fromRGB(240, 240, 245)
endpointBox.PlaceholderText = DEFAULT_API
endpointBox.ClearTextOnFocus = false
endpointBox.TextXAlignment = Enum.TextXAlignment.Left
endpointBox.TextSize = 14
endpointBox.Text = plugin:GetSetting(SETTING_KEY) or DEFAULT_API
endpointBox.Parent = root

local controls = Instance.new("Frame")
controls.LayoutOrder = 3
controls.Size = UDim2.new(1, 0, 0, 34)
controls.BackgroundTransparency = 1
controls.Parent = root

local saveButton = Instance.new("TextButton")
saveButton.Size = UDim2.new(0.5, -4, 1, 0)
saveButton.BackgroundColor3 = Color3.fromRGB(55, 55, 62)
saveButton.BorderSizePixel = 0
saveButton.Text = "Save URL"
saveButton.TextColor3 = Color3.fromRGB(245, 245, 245)
saveButton.TextSize = 14
saveButton.Parent = controls

local refreshButton = Instance.new("TextButton")
refreshButton.Position = UDim2.new(0.5, 4, 0, 0)
refreshButton.Size = UDim2.new(0.5, -4, 1, 0)
refreshButton.BackgroundColor3 = Color3.fromRGB(55, 55, 62)
refreshButton.BorderSizePixel = 0
refreshButton.Text = "Refresh"
refreshButton.TextColor3 = Color3.fromRGB(245, 245, 245)
refreshButton.TextSize = 14
refreshButton.Parent = controls

local statusLabel = Instance.new("TextLabel")
statusLabel.LayoutOrder = 4
statusLabel.Size = UDim2.new(1, 0, 0, 24)
statusLabel.BackgroundTransparency = 1
statusLabel.Text = "Not loaded"
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.TextColor3 = Color3.fromRGB(180, 180, 188)
statusLabel.TextSize = 14
statusLabel.Parent = root

local list = Instance.new("ScrollingFrame")
list.LayoutOrder = 5
list.Size = UDim2.new(1, 0, 1, -130)
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

local function clearRows()
    for _, child in list:GetChildren() do
        if child:IsA("TextLabel") then
            child:Destroy()
        end
    end
end

local function addRow(event, index)
    local payloadText = HttpService:JSONEncode(event.EventPayload or {})
    local text = string.format(
        "%s\n%s\n%s",
        tostring(event.EventTime or "unknown time"),
        tostring(event.EventType or "unknown event"),
        payloadText
    )

    local row = Instance.new("TextLabel")
    row.LayoutOrder = index
    row.Size = UDim2.new(1, -4, 0, 0)
    row.AutomaticSize = Enum.AutomaticSize.Y
    row.BackgroundColor3 = Color3.fromRGB(38, 38, 44)
    row.BorderSizePixel = 0
    row.TextColor3 = Color3.fromRGB(235, 235, 240)
    row.TextXAlignment = Enum.TextXAlignment.Left
    row.TextYAlignment = Enum.TextYAlignment.Top
    row.TextWrapped = true
    row.Font = Enum.Font.Code
    row.TextSize = 13
    row.Text = text
    row.Parent = list

    local rowPadding = Instance.new("UIPadding")
    rowPadding.PaddingTop = UDim.new(0, 8)
    rowPadding.PaddingBottom = UDim.new(0, 8)
    rowPadding.PaddingLeft = UDim.new(0, 8)
    rowPadding.PaddingRight = UDim.new(0, 8)
    rowPadding.Parent = row
end

local function refresh()
    local baseUrl = endpointBox.Text:gsub("/+$", "")
    if baseUrl == "" then
        statusLabel.Text = "Set an API URL first."
        return
    end

    statusLabel.Text = "Loading..."
    local ok, result = pcall(function()
        local response = HttpService:GetAsync(baseUrl .. "/api/refunds?limit=20", true)
        return HttpService:JSONDecode(response)
    end)

    if not ok then
        statusLabel.Text = "Request failed: " .. tostring(result)
        return
    end

    clearRows()
    local events = result.events or {}
    if #events == 0 then
        statusLabel.Text = "Connected. No refund events yet."
        return
    end

    for index, event in ipairs(events) do
        addRow(event, index)
    end
    statusLabel.Text = string.format("Connected. %d refund event(s).", #events)
end

saveButton.MouseButton1Click:Connect(function()
    local value = endpointBox.Text:gsub("%s+$", ""):gsub("^%s+", "")
    plugin:SetSetting(SETTING_KEY, value)
    statusLabel.Text = "API URL saved."
end)

refreshButton.MouseButton1Click:Connect(refresh)

openButton.Click:Connect(function()
    widget.Enabled = not widget.Enabled
    if widget.Enabled then
        refresh()
    end
end)
