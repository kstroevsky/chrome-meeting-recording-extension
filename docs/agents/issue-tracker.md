# Issue tracker: Linear

Issues for this repo live in Linear under the **Kstroevsky** team. Use the Linear MCP tools for all operations — no CLI required.

## Conventions

- **Create an issue**: `mcp__claude_ai_Linear__save_issue` with `teamId`, `title`, and `description`.
- **Read an issue**: `mcp__claude_ai_Linear__get_issue` with the issue ID or URL.
- **List issues**: `mcp__claude_ai_Linear__list_issues` with `team: "Kstroevsky"` and appropriate filters.
- **Comment on an issue**: `mcp__claude_ai_Linear__save_comment` with `issueId` and `body`.
- **Apply labels**: `mcp__claude_ai_Linear__save_issue` with `labelIds`, or create a new label via `mcp__claude_ai_Linear__create_issue_label`.
- **Close / update status**: `mcp__claude_ai_Linear__save_issue` with the appropriate `stateId` (fetch available statuses via `mcp__claude_ai_Linear__get_issue_status`).

## Team details

- **Team name**: Kstroevsky
- **Team ID**: `d21c3c46-b813-46f2-b6a5-5beddcacb5fc`

## When a skill says "publish to the issue tracker"

Call `mcp__claude_ai_Linear__save_issue` with:
- `teamId: "d21c3c46-b813-46f2-b6a5-5beddcacb5fc"`
- `title` and `description` from the issue content

## When a skill says "fetch the relevant ticket"

Call `mcp__claude_ai_Linear__get_issue` with the issue ID, then `mcp__claude_ai_Linear__list_comments` to retrieve comments.
