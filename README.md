# skills

Agent skills I use day to day, packaged so any agent that reads
[SKILL.md](https://code.claude.com/docs/en/skills) can pick them up.

## Install

Point the [`skills`](https://github.com/vercel-labs/skills) CLI at this repository:

```bash
npx skills@latest add rodolfosilva/skills
```

With bun:

```bash
bunx skills@latest add rodolfosilva/skills
```

The CLI copies each skill under `skills/` into the agent directory of the project you run
it from. Run it again to pull updates.

Install globally, for every project, with `-g`. Install one skill instead of all of them
with `--skill`, and see what is on offer first with `--list`:

```bash
npx skills@latest add rodolfosilva/skills --list
npx skills@latest add rodolfosilva/skills --skill send-pr -g -a claude-code -y
```

## Skills

| Skill | What it does |
| --- | --- |
| [`pixel-perfect`](skills/pixel-perfect) | Turns design fidelity into a number. Exports the design frame, captures the running screen at the same pixel dimensions over CDP, diffs the two with ImageMagick, then reads the diff image to tell a real defect from the floor every text rasterizer imposes. |
| [`send-pr`](skills/send-pr) | Opens, updates and shepherds a Pull Request. Runs the checks CI would run before pushing, infers the title convention from the repo history, has a second agent review the text, walks the web change in a real browser with `agent-browser` and attaches the screenshot or screen recording it captured there, then watches CI and review comments. |

## Dependencies

### pixel-perfect

[ImageMagick](https://imagemagick.org) provides `magick`, which reads the reference
dimensions and computes the diff. The capture script needs Node 24, for the global
`WebSocket`, and a `chrome-headless-shell` binary.

```bash
brew install imagemagick
npx playwright install chromium-headless-shell
```

The script finds the binary in the Playwright cache on its own. Point
`CHROME_HEADLESS_SHELL` at another one if you keep it somewhere else.

### send-pr

The skill drives [`gh`](https://cli.github.com) throughout, and needs **v2.99.0 or newer**:
that is the release where `--attach` started uploading local screenshots and screen
recordings into the pull request body. GitHub's public API has no endpoint for that, so an
older `gh` leaves the skill with no way to attach visual evidence.

```bash
brew install gh   # or: brew upgrade gh
gh --version
```

GitHub Enterprise Server does not support the flag yet. On GHES the skill falls back to
driving the web editor with `agent-browser`.

[`agent-browser`](https://github.com/vercel-labs/agent-browser) is what the skill uses to
open the branch in a real browser: it walks the states the diff touches, reads the console
for exceptions the screenshot would hide, then takes the stills or records the clip that
ends up in the PR body. It is a CLI over CDP, so it needs no browser extension and works
headless.

```bash
brew install agent-browser
agent-browser install
```

Or through npm:

```bash
npm i -g agent-browser && agent-browser install
```

`agent-browser install` downloads the Chromium binary, without it every command fails at
launch. On Linux add `--with-deps` to pull the system libraries too. Check it with
`agent-browser doctor`.

[argent](https://github.com/software-mansion/argent) is the equivalent for native, and is
needed only when the diff touches a React Native or Expo screen.

### Letting the agent set it up

Paste this into Claude Code, or any agent that can edit your settings, and it will install
and wire everything up:

> Install `agent-browser` on this machine (`brew install agent-browser`, or
> `npm i -g agent-browser` if Homebrew is not available), then run `agent-browser install`
> to fetch the Chromium binary and `agent-browser doctor` to confirm the install is clean.
> Then configure a `PreToolUse` hook in `~/.claude/settings.json`, matching the `Bash` tool,
> that inspects the command and fires only when it contains `gh pr create` or `gh pr edit`:
> the hook should check that `agent-browser` is on `PATH` and exit non-zero with a short
> message on stderr telling me to capture the screen with `agent-browser` before opening the
> PR when it is not, so a PR is never published without the tool that produces its visual
> evidence being available. Keep the hook a single small shell script under
> `~/.claude/hooks/`, referenced by path from the settings file rather than inlined, make it
> exit 0 for every command that is not a `gh pr` one so it never slows down normal work, and
> show me the final settings diff before writing it.

## Validation

Every `SKILL.md` is checked on push and on pull request by
[`.github/workflows/validate-skills.yml`](.github/workflows/validate-skills.yml). It catches
what silently breaks an install: frontmatter that is not valid YAML, a missing `name` or
`description`, a `name` that does not match its directory, a `description` over the 1024
character limit, and references pointing at files that do not exist.

Run it locally before pushing:

```bash
npm install
npm run validate
```

## License

[MIT](LICENSE)
