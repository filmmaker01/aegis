# Agent provenance

## Upstream-derived agents (copied as-is)
Source: https://github.com/msitarzewski/agency-agents (MIT License, © 2025 AgentLand
Contributors). Local checkout kept at `tooling/agency-agents/` (git-ignored, not part of the
Aegis product repo). The MIT license permits copying and modification; the copyright notice is
preserved here.

Installed into `.claude/agents/`:

| File | Role for Aegis |
|------|----------------|
| `project-manager-senior.md` | tech lead / project manager |
| `engineering-software-architect.md` | software architect |
| `engineering-frontend-developer.md` | frontend developer (Mini App) |
| `engineering-backend-architect.md` | backend developer |
| `engineering-database-optimizer.md` | database engineer |
| `engineering-code-reviewer.md` | code reviewer |
| `security-appsec-engineer.md` | security engineer |
| `testing-test-automation-engineer.md` | QA / test automation |
| `design-ux-architect.md` | product / UX designer |

## Custom agents (written for Aegis, not from upstream)
| File | Role |
|------|------|
| `telegram-integration-specialist.md` | Telegram Bot API / Business Connections / Mini Apps expert |
| `aegis-lead.md` | master orchestrator (context, routing, gates, roadmap, decision log) |

We intentionally installed a **minimal** set (10 roles), not the full upstream roster.
