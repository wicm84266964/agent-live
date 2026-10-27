# Security Policy

## Supported versions

Security fixes apply to the latest release and the current `main` branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** action in the Security tab.

Include the version or commit, a minimal reproduction, and the impact. Remove API keys, session transcripts, local paths, and personal information before attaching logs.

You should receive an initial acknowledgement within 7 days.

## Local boundary

The HTTP hook has no authentication and listens only on `127.0.0.1`. Do not expose it on a LAN or public interface. Anyone who can POST to it can put events on your screen.

Profiles do not copy tool arguments or tool output into the event stream. Do not commit raw agent transcripts. They can contain paths, commands, and secrets.
