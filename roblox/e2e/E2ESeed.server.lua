local RunService = game:GetService("RunService")
assert(RunService:IsStudio(), "E2E seed must only run in Studio")

local Fixture = require(script.Parent.E2EFixture)
local state = Fixture.Reset()

print(string.format(
	"[Backtrack E2E] seeded user=%d gems=%d executions=%d",
	Fixture.UserId,
	state.Gems,
	state.HandlerExecutions
))

script.Disabled = true
