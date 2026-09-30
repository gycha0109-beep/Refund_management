local Fixture = require(script.Parent.E2EFixture)

return {
	[Fixture.ProductId] = function(action)
		return Fixture.Reverse500Gems(action)
	end,

	[Fixture.FailingProductId] = function()
		return Fixture.ForcedFailure()
	end,
}
