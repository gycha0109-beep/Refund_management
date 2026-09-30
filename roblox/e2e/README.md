# Roblox Pro E2E fixture

These files are for a dedicated Roblox Studio test place only. The executable pieces assert `RunService:IsStudio()`.

Place them under the plugin-installed runtime:

```text
ServerScriptService
└── RobuxBacktrackPro
    ├── RobuxBacktrackServer
    ├── Bootstrap              <- disable during E2E
    ├── ProductHandlers        <- unused during E2E
    ├── E2EFixture             <- ModuleScript
    ├── E2EProductHandlers     <- ModuleScript
    ├── E2ESeed                <- Script
    ├── E2EInspect             <- Script
    └── E2EBootstrap           <- Script
```

Set attributes on `E2EBootstrap`:

- `BackendBaseUrl` string: dedicated Pro staging backend URL.
- `SecretName` string: defaults to `RobuxBacktrackActionKey`.
- `FaultMode` string: empty normally, or `AFTER_HANDLER_BEFORE_COMPLETE` for ACK-loss recovery.

Fixture constants:

- UserId `123456789`
- ProductId `987654321`
- Failing ProductId `987654322`
- Starting balance `1000 Gems`
- Reversal `500 Gems`

`E2ESeed` disables itself after seeding. Before an ACK-loss restart, confirm it is disabled so the balance is not reset.
