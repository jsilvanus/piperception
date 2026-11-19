# systemd user unit

`piperception.service` runs piperception as a systemd user service.

Expected layout (relative to the service user's home, `%h`):

- app checkout (built, with `dist/`): `~/apps/piperception`
- environment file: `~/apps/piperception.env` (all settings and secrets live here, never in git)
- Node.js: `~/.local/bin/node`

The `After=` line orders it behind `mediamtx.service` and `fffleet-orchestrator.service`; drop what you do not run.

Install:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/piperception.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now piperception
loginctl enable-linger "$USER"   # once, so it runs without a login session
```

Status and logs: `systemctl --user status piperception`, `journalctl --user -u piperception -f`.
