local DataStoreService = game:GetService("DataStoreService")
local RunService = game:GetService("RunService")

assert(RunService:IsStudio(), "Robux Backtrack E2E fixture is Studio-only")

local Fixture = {
	UserId = 123456789,
	ProductId = 987654321,
	FailingProductId = 987654322,
	StartingGems = 1000,
	RefundGems = 500,
	DataStoreName = "RobuxBacktrackE2EBalanceV1",
}

local store = DataStoreService:GetDataStore(Fixture.DataStoreName)

local function userKey(userId)
	return "user:" .. tostring(userId)
end

local function normalize(current)
	current = current or {}
	current.Gems = tonumber(current.Gems) or 0
	current.HandlerExecutions = tonumber(current.HandlerExecutions) or 0
	current.AppliedActions = current.AppliedActions or {}
	return current
end

function Fixture.Reset()
	store:SetAsync(userKey(Fixture.UserId), {
		Gems = Fixture.StartingGems,
		HandlerExecutions = 0,
		AppliedActions = {},
		SeededAt = os.time(),
	})

	return Fixture.Get()
end

function Fixture.Get()
	return normalize(store:GetAsync(userKey(Fixture.UserId)))
end

function Fixture.Reverse500Gems(action)
	assert(tonumber(action.UserId) == Fixture.UserId, "unexpected E2E user")
	assert(tonumber(action.ProductId) == Fixture.ProductId, "unexpected E2E product")

	local actionId = tostring(action.ActionId)
	local result

	store:UpdateAsync(userKey(Fixture.UserId), function(current)
		current = normalize(current)

		if current.AppliedActions[actionId] then
			result = current
			return current
		end

		current.Gems -= Fixture.RefundGems
		current.HandlerExecutions += 1
		current.AppliedActions[actionId] = true
		current.LastActionId = actionId
		current.LastAppliedAt = os.time()
		result = current
		return current
	end)

	return result ~= nil
end

function Fixture.ForcedFailure()
	return false, "e2e_forced_failure"
end

return Fixture
