local RunService = game:GetService("RunService")
assert(RunService:IsStudio(), "E2E inspect must only run in Studio")

local Fixture = require(script.Parent.E2EFixture)
local state = Fixture.Get()

print(string.format(
	"[Backtrack E2E] user=%d gems=%d executions=%d lastAction=%s",
	Fixture.UserId,
	state.Gems,
	state.HandlerExecutions,
	tostring(state.LastActionId)
))
