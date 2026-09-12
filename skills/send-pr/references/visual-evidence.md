# Visual evidence for a PR

Two jobs: produce the file, then get it into the body. The second one is the same for every stack, one `--attach` flag on the `gh` command that publishes the PR.

## What to capture

Read the diff and pick the shortest path that shows the change to someone who has never seen it.

- Start on the screen the change lives in. Login, seeding and navigation to get there are setup, not evidence, do them before recording.
- A fix shows both behaviors: the bug reproduced on the base commit, then the fixed flow on the branch, posted side by side as before and after. Without the before, the reviewer has to take the reproduction on faith.
- A purely visual change (spacing, color, copy, empty state) is a still. A still is read in one second, a video of a still is read in none.
- A flow, an animation, a gesture or anything with timing is a video.
- One line of intro in the body is enough. Do not narrate the clip frame by frame, the reader is watching it.

Write every file outside the repository, the session scratchpad or `/tmp`, so a stray screenshot never lands in a commit.

## Native app, React Native and Expo, with argent

The app has to be running the branch's code: dev-client plus Metro on the branch, or a rebuild if native code changed. Project specifics live in the repo's own rules and skills.

1. `list-devices`, prefer a device already booted, and take its `udid`.
2. Get the app to the starting screen first.
3. `screen-recording-start` with that `udid` and `timeLimitSeconds` a bit over the planned flow. Keep the defaults: `trimStatic` cuts the dead air, `showTouches` draws where each tap landed, which is exactly what a reviewer needs.
4. Drive the flow with the normal discovery loop, a discovery tool before every tap, never coordinates read off a screenshot. See the `argent-device-interact` skill.
5. `screen-recording-stop`, which returns the mp4 path under `.argent/recordings/`. That folder is gitignored, never commit the video.
6. Check the size against the limits below before publishing. A simulator recording of a short flow lands well under them, a three minute walkthrough does not.

The recording keeps running across other tool calls, so stop it as soon as the flow ends rather than leaving it to the time limit.

### Which platform

iOS by default. Android when the reported issue is about Android: the ticket or issue names it, the branch says `android`, or the diff sits in `android/`, `*.android.tsx` or `Platform.OS === 'android'` branches. Both only when the fix has a platform-specific side on each. Boot and connect through the `argent-ios-simulator-setup` or `argent-android-emulator-setup` skill, the interaction loop is the same on both.

### Before and after for a fix

Two clips of the same flow, same device, same starting screen, so the only difference the reviewer sees is the fix.

1. Note the branch's base (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`) and make sure `git status` is clean, stash if not.
2. Check out the base, `git checkout <base>`, or open it in a separate worktree (`git worktree add /tmp/before <base>`) when the app can point Metro at another directory, which avoids touching the branch checkout at all.
3. Get the app running the base code: reload Metro for a JS-only change, rebuild when native code or dependencies changed. A "before" recorded on the branch's build is not a before.
4. Record the flow with the loop above, reproducing the bug. Copy the mp4 out of `.argent/recordings/` to `/tmp/evidence/before.mp4`, since the next checkout may not keep it.
5. Come back to the branch, `git checkout -` and `git stash pop` if used, or drop the worktree (`git worktree remove /tmp/before`), reload or rebuild again, and record the same flow to `/tmp/evidence/after.mp4`.
6. Both clips go in the Before/After table described in step 5 of the skill, before on the left.

Record the before first: if the bug does not reproduce on the base, the fix is for something else, and that is worth knowing before opening the PR.

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
agent-browser screenshot /tmp/evidence/empty-state.png
agent-browser screenshot --full /tmp/evidence/long-page.png
```

One shot per state that actually changed, not one per page of the product. `--full` captures
the whole scroll height, worth it for a long page, noise for a single component.

Responsive change, take the second shot at a phone width:

```bash
agent-browser set viewport 390 844
agent-browser screenshot /tmp/evidence/mobile.png
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
agent-browser record start /tmp/evidence/flow.webm
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

## Attaching the files with gh

`gh` uploads local media since **v2.99.0** and mints the `https://github.com/user-attachments/assets/<uuid>` URLs GitHub renders inline in any repository visibility, video included. Nothing else is needed, and no other host produces a URL that renders in a private repo.

The flag is on `gh pr create`, `gh pr edit`, `gh pr comment`, and the three `gh issue` equivalents:

```bash
gh pr create --base main --title "..." --body "$(cat body.md)" \
  --attach "/tmp/evidence/empty-state.png#Empty list before the fix" \
  --attach "/tmp/evidence/filled.png#List after the fix" \
  --attach /tmp/evidence/flow.webm
```

- **Repeatable, one flag per file.** Alt text goes after a `#`, glued to the path so it cannot slip onto the wrong file. Left off, `gh` derives it from the file name.
- **A local path already written in the body is rewritten in place**, keeping the alt text and the position you chose. So stills go in the body as `![Empty list before the fix](/tmp/evidence/empty-state.png)` and land exactly where the section says.
- **Anything attached but never referenced is appended at the end.** That is where a single video belongs, alone on its line, which is the form GitHub turns into a player.
- **Videos in a table need a `<video>` tag.** A bare URL in a cell is a link, not a player. Write `<video src="/tmp/evidence/before.mp4"></video>` in the cell, attach the file, then check with `gh pr view --json body` that the `src` became a `user-attachments` URL. If it did not, the URL is at the bottom of the body, paste it into the `src` and `gh pr edit --body` again.
- **png, jpeg, gif, webp, svg, mp4, mov and webm.** GitHub rejects the rest at the server, so a PDF or a diagram has to become a PNG first.
- **Push access on the repository is required**, and GitHub Enterprise Server is not supported in this release.

Confirm with `gh pr view --json body` that every local path became a `user-attachments` URL. A path left untouched means the upload did not happen.

### Size limits

`gh` uploads the file as it is, it does not compress. GitHub caps images and GIFs at 10 MB, and video at 10 MB on a free plan, 100 MB on a paid one.

Over the limit, the first answer is a shorter recording: the flow that shows the change is rarely more than a few seconds, and a clip nobody watches to the end is not evidence. When the flow really is that long, re-encode instead of cutting:

```bash
ffmpeg -i flow.webm -vf "scale=720:-2" -c:v libvpx-vp9 -crf 40 -b:v 0 -an flow-small.webm
```

Drop the frame rate too (`-r 15`) if it is still too big. An mp4 takes the same treatment with `-c:v libx264 -crf 30 -preset slow`.

### When gh is too old

`gh --version` under 2.99.0 has no `--attach`, and the flag fails the command outright rather than degrading. Upgrade it (`brew upgrade gh`) and rerun. If that is not possible in this session, say so and use the manual path below, do not publish a PR that silently lost its evidence.

The manual path drives the GitHub web editor, so it needs a browser logged into GitHub, which means the user's own Chrome profile:

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
