"""Live progress bar for a running scan (§53).

Edits a single message rather than posting a new one per stage, and throttles
edits so a fast scan does not burn the interaction's rate limit.
"""

from __future__ import annotations

import time

import discord

from app.orchestrator import STAGES

ICONS = {"pending": "⏳", "running": "🔄", "done": "✅", "failed": "❌"}
#: Minimum seconds between message edits.
EDIT_INTERVAL = 0.8


class ProgressReporter:
    def __init__(self, interaction: discord.Interaction, *, mint: str) -> None:
        self.interaction = interaction
        self.mint = mint
        self.states: dict[str, str] = {key: "pending" for key, _ in STAGES}
        self._last_edit = 0.0
        self._message: discord.WebhookMessage | None = None

    def render(self) -> str:
        lines = [f"**Scanning** `{self.mint[:12]}…`", ""]
        lines.extend(f"{ICONS[self.states[key]]} {label}" for key, label in STAGES)
        return "\n".join(lines)

    async def start(self) -> None:
        self._message = await self.interaction.followup.send(self.render(), wait=True)

    async def update(self, stage: str, status: str) -> None:
        if stage not in self.states:
            return
        self.states[stage] = status
        if status == "done":
            # Any earlier stage still pending has been skipped by the depth profile.
            for key, _ in STAGES:
                if key == stage:
                    break
                if self.states[key] == "pending":
                    self.states[key] = "done"
        now = time.monotonic()
        if status != "done" and now - self._last_edit < EDIT_INTERVAL:
            return
        self._last_edit = now
        await self._edit(self.render())

    async def finish(self, text: str | None = None) -> None:
        for key in self.states:
            if self.states[key] in {"pending", "running"}:
                self.states[key] = "done"
        await self._edit(text or self.render())

    async def fail(self, message: str) -> None:
        for key, state in self.states.items():
            if state == "running":
                self.states[key] = "failed"
        await self._edit(f"{self.render()}\n\n❌ {message}")

    async def _edit(self, content: str) -> None:
        if self._message is None:
            return
        try:
            await self._message.edit(content=content)
        except discord.HTTPException:
            pass
