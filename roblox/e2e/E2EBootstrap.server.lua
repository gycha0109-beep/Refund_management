local RunService = game:GetService("RunService")
assert(RunService:IsStudio(), "Robux Backtrack E2E bootstrap is Studio-only")

local Backtrack = require(script.Parent.RobuxBacktrackServer)
local handlers = require(script.Parent.E2EProductHandlers)

local baseUrl = script:GetAttribute("BackendBaseUrl")
local secretName = script:GetAttribute("SecretName") or "RobuxBacktrackActionKey"
local faultMode = script:GetAttribute("FaultMode")

assert(type(baseUrl) == "string" and baseUrl ~= "", "Set BackendBaseUrl attribute on E2EBootstrap")

Backtrack.Configure({
	BaseUrl = baseUrl,
	SecretName = secretName,
	PollIntervalSeconds = 5,
	JitterSeconds = 0,
	LeaseSeconds = 15,
	MaxActionsPerPoll = 10,
	TestFault = faultMode ~= "" and faultMode or nil,
})

for productId, handler in pairs(handlers) do
	Backtrack.RegisterProduct(productId, handler)
end

print("[Backtrack E2E] bootstrap started", "faultMode=", tostring(faultMode))
Backtrack.Start()
