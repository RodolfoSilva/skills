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
| [`send-pr`](skills/send-pr) | Opens, updates and shepherds a Pull Request. Runs the checks CI would run before pushing, infers the title convention from the repo history, has a second agent review the text, attaches a screenshot or a screen recording of the change, then watches CI and review comments. |

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

[`ghmedia`](https://github.com/salao365/ghmedia) uploads the screenshots and screen
recordings into the pull request body. GitHub's public API has no endpoint for that and
`gh` cannot do it, so without `ghmedia` the skill has no way to attach visual evidence.

```bash
brew install salao365/tap/ghmedia
```

Or without Homebrew:

```bash
curl -fsSL https://raw.githubusercontent.com/salao365/ghmedia/main/install.sh | sh
```

It needs [ffmpeg](https://ffmpeg.org) on `PATH` (Homebrew pulls it in, the install script
does not) and a GitHub token, taken from `GH_TOKEN`, then `GITHUB_TOKEN`, then
`gh auth token`. If you already use the [GitHub CLI](https://cli.github.com) there is
nothing else to set up.

The skill drives [`gh`](https://cli.github.com) throughout, so that one is not optional
either. Two more are needed only when the diff touches the stack they cover:
[argent](https://github.com/software-mansion/argent) to record a React Native or Expo flow,
and the Claude in Chrome extension to screenshot LiveView, email templates and React pages.

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
