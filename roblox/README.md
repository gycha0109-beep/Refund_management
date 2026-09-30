# Roblox server SDK (Pro prototype)

This folder is the P2 prototype for Robux Backtrack Pro. It is not part of the currently published free Creator Store plugin.

## What it does

The module polls the backend for claimable refund actions, takes a short lease, finds the registered ProductId handler, writes a local DataStore execution marker, runs the game-specific handler, and acknowledges the result.

The local marker makes the safe default conservative:

- `APPLIED` locally + backend acknowledgement lost -> reclaim later and acknowledge without running the handler twice.
- `STARTED` or `FAILED` locally -> do not automatically run the handler again; send the action to manual review.
- A handler is never guessed. Unknown ProductIds fail closed.

This avoids pretending distributed side effects can be exactly-once.

## Required Roblox settings

1. Enable **Allow HTTP Requests** in the experience security settings.
2. Create a secret named `RobuxBacktrackActionKey` whose value matches backend `ACTION_API_KEY`.
3. For local Studio playtests, configure the equivalent local secret.
4. Require the module only from a server Script.

## Example

```lua
local ServerScriptService = game:GetService("ServerScriptService")
local Backtrack = require(ServerScriptService.RobuxBacktrackServer)

Backtrack.Configure({
	BaseUrl = "https://YOUR-BACKEND.example.com",
	SecretName = "RobuxBacktrackActionKey",
})

Backtrack.RegisterProduct(987654321, function(action)
	-- This callback is game-specific and must support an offline UserId.
	-- Example only: update your own persistent player data here.
	print("Reverse product", action.ProductId, "for user", action.UserId)
end)

Backtrack.Start()
```

A handler may return `false, "reason"` to mark the action failed. Throwing an error also marks it failed.

## Important

Do not put `ACTION_API_KEY` in a LocalScript, ReplicatedStorage value, plugin source, or other client-visible location.

The module uses a dedicated DataStore only for execution markers. It does not know the schema of your economy/profile data and therefore does not directly subtract currency or delete items on its own.
