# Visual evidence for a PR

Two jobs: produce the file, then get it into the body. The second one is the same for every stack because `gh` cannot upload.

## What to capture

Read the diff and pick the shortest path that shows the change to someone who has never seen it.

- Start on the screen the change lives in. Login, seeding and navigation to get there are setup, not evidence, do them before recording.
- A fix shows the fixed behavior. If the bug is subtle enough that the fix looks like nothing, capture the base commit too and post before and after.
- A purely visual change (spacing, color, copy, empty state) is a still. A still is read in one second, a video of a still is read in none.
- A flow, an animation, a gesture or anything with timing is a video.
- One line of intro in the body is enough. Do not narrate the clip frame by frame, the reader is watching it.

## Native app, React Native and Expo, with argent

The app has to be running the branch's code: dev-client plus Metro on the branch, or a rebuild if native code changed. Project specifics live in the repo's own rules and skills.

1. `list-devices`, prefer a device already booted, and take its `udid`.
2. Get the app to the starting screen first.
3. `screen-recording-start` with that `udid` and `timeLimitSeconds` a bit over the planned flow. Keep the defaults: `trimStatic` cuts the dead air, `showTouches` draws where each tap landed, which is exactly what a reviewer needs.
4. Drive the flow with the normal discovery loop, a discovery tool before every tap, never coordinates read off a screenshot. See the `argent-device-interact` skill.
5. `screen-recording-stop`, which returns the mp4 path under `.argent/recordings/`. That folder is gitignored, never commit the video.
6. Do not worry about the file size, `ghmedia` fits it. It refuses only when the recording is so long that fitting would make it unreadable, and then the answer is a shorter path, not more compression.

The recording keeps running across other tool calls, so stop it as soon as the flow ends rather than leaving it to the time limit.

A still from the app comes from `screenshot` with `scale: 1.0` and `includeImageInContext: false`, which writes the file without dumping the image into context.

## Web, LiveView, emails and React, with agent-browser

`agent-browser` is a CLI, so the whole loop is Bash: no extension to install in the user's
browser, no tab of theirs to hijack, and the same commands work headless on a machine with
no display. Check `command -v agent-browser` first. If it is missing, say so and fall back
to whatever browser tooling the session has, do not silently skip the evidence.

### Isolate the session first

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix send-pr)"
```

The unnamed session is shared with every other agent on the machine and survives across
conversations. Working in it navigates away from whatever the human left open. Derive the
name once, at the top, and every later command inherits it from the environment.

Close it when the evidence is captured:

```bash
agent-browser close
```

### Test the change before capturing it

Evidence of a broken screen is still evidence, but discovering it in the PR is late. Walk
the change first, and only then record the walk you already know works.

1. Local server running the branch's code. If it is not up, start it the way the repo's own
   rules and skills say to, not by guessing a command.
2. `agent-browser open <url>` on the affected route. Emails go to the preview mailbox,
   `/dev/mailbox` on Phoenix, never a real inbox.
3. `agent-browser snapshot -i` to see what is on the page, then act on the `@eN` refs it
   prints. Refs go stale the moment the page changes, so re-snapshot after every click,
   submit or re-render.
4. Wait on something real between steps: `wait --text "..."`, `wait --url "**/path"`, or
   `wait --load networkidle`. A bare `wait 2000` is for debugging, not for a flow you are
   about to record.
5. Exercise every state the diff touches, not just the happy path: empty, filled, error,
   loading. A validation the PR changed is worth submitting the form wrong on purpose.
6. Read the browser's own complaints before deciding it works:

```bash
agent-browser errors
agent-browser console --clear
```

An exception or a failed request in there is a bug the PR is about to ship. Fix it, rerun
step 1 of the skill, and walk the flow again. Do not open the PR on top of it and mention
it in the body.

If the diff is about accessibility, contrast or semantics, `agent-browser a11y --json` gives
the axe-core violations with selectors, which is a better claim in the PR body than "looks
fine".

### Screenshots

```bash
agent-browser screenshot empty-state.png
agent-browser screenshot --full long-page.png
```

One shot per state that actually changed, not one per page of the product. `--full` captures
the whole scroll height, worth it for a long page, noise for a single component.

Responsive change, take the second shot at a phone width:

```bash
agent-browser set viewport 390 844
agent-browser screenshot mobile.png
agent-browser set viewport 1440 900
```

`agent-browser set device "iPhone 15"` does the same with the device's user agent and pixel
ratio, which matters when the change is behind a UA or touch check.

A before and after pair comes from the same commands run on the base commit and on the
branch, saved to two files. Stash or check out the base, capture, come back. Say which is
which in the alt text.

### Video

```bash
agent-browser open http://localhost:4000/checkout
agent-browser record start flow.webm
# ... snapshot, click, fill, wait ...
agent-browser record stop
```

GitHub renders `webm` inline, so the file goes up as it comes out, no conversion.

- Start recording on the screen the change lives in. Login, seeding and navigation to get
  there are setup, not evidence.
- A `wait 500` after each action is the one place a dumb wait earns its keep: it gives the
  viewer a beat to see what happened. Without it the clip is a flicker.
- Stop as soon as the flow ends. The recording keeps running across every other command.
- Nothing with timing to show is a screenshot, not a video. A still is read in one second,
  a video of a still is read in none.

## Uploading into the body

`gh pr create --body` takes text only, and a `raw.githubusercontent` link renders as a link, not as a player. The only URL GitHub renders inline in any repository visibility, and the only one that turns a video into a player, is `https://github.com/user-attachments/assets/<uuid>`. `ghmedia` mints those from the command line, which is why this step no longer needs a browser.

```bash
ghmedia upload --repo <owner>/<name> \
  "empty-state.png=Empty list before the fix" \
  "filled.png=List after the fix" \
  flow.mp4
```

- **stdout is markdown and nothing else.** Images come back as `![alt](url)`, video as a bare URL alone on its line, which is the only form GitHub turns into a player. Paste it as it comes, do not rewrap the video.
- **stderr is the log**: original size, what the encode decided, final size. Read it when something looks wrong, ignore it otherwise.
- **Alt text goes after an equals sign**, glued to the file so it cannot slip onto the wrong one. Without it, the alt is derived from the file name, so a screenshot saved as `payment-error.png` documents itself and one saved as `2026-08-21-135042.png` does not.
- **`--repo` is the repository the PR lives in.** Contributing through a fork, where you cannot push upstream, add `--host-repo <your>/<repo>`: the upload needs push access, and the asset URL renders anywhere regardless of where it was hosted.
- `--dry-run` prints what would happen to each file without encoding or uploading.

Then put the output in the body:

```bash
gh pr edit <number> --body "$(cat <<'EOF'
<body with the markdown pasted into the media section>
EOF
)"
```

Confirm with `gh pr view --json body` that the `user-attachments` URL is in there.

Updating a PR replaces the media line, it does not stack. Three clips from three pushes tell the reviewer nothing about which one is the current behavior.

### What it will not do

- **Only png, jpeg, gif, webp, mp4, mov and webm.** GitHub rejects everything else at the server, PDF and SVG included, so no amount of compression gets them in. A diagram has to become a PNG first.
- **Push access is required** on whatever `--host-repo` resolves to. Without it the endpoint answers 404, not 403, so the message says push access even though GitHub says Not Found.
- **It refuses a recording that cannot fit without becoming unreadable.** That is a signal to record less, not a bug.

### When it fails

The endpoint `ghmedia` uses is undocumented, so it can break without notice. There is no fallback chain on purpose: every alternative host produces a URL that renders worse, or not at all in a private repo, and finding that out through a reviewer saying they see nothing is worse than a clear failure.

The manual path still works, and is the escape hatch. It drives the GitHub web editor, so it
needs a browser logged into GitHub, which means the user's own Chrome profile:

```bash
agent-browser --profile Default --headed open <pr-url>
```

1. Create the PR first, body already written, media section still empty.
2. `snapshot -i` on the PR page, click the `...` menu on the first comment, then `Edit`.
3. `snapshot -i` again, the editor is a new part of the page. `click` the textarea,
   `press Control+End` to reach the end, `type` the intro line.
4. Find the file input with `agent-browser find role button --name "Attach files"` or a
   `snapshot -i` scoped to the open editor. **Two of them exist on the page**, the editor you
   opened and the "Add a comment" box at the bottom. Take the one inside the open editor, the
   other one puts the file in a new comment instead of the body.
5. `agent-browser upload <ref> shot.png flow.webm`. GitHub inserts the markdown at the cursor
   by itself, so nothing has to be typed.
6. Wait for the upload to finish (`wait --text "shot.png"` beats guessing), click
   `Update comment`, then confirm with `gh pr view --json body` that the `user-attachments`
   URL is in there.
7. `agent-browser close`.

A profile in use by a running Chrome cannot be opened a second time. Either quit Chrome first
or point `--profile` at a copied directory.
