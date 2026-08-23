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

## Web, LiveView, emails and React, with Chrome

1. Local server running the branch.
2. `tabs_context_mcp`, then `tabs_create_mcp` for a new tab. Do not take over a tab the user is working in.
3. `navigate` to the affected route. Emails are captured in the preview mailbox, `/dev/mailbox` on Phoenix, not in a real inbox.
4. `computer` with `action: "screenshot"` and `save_to_disk: true`, which returns the path to upload. Without that flag the image only lands in context and there is nothing to attach.
5. Responsive change: `resize_window` to a phone width and take the second shot.
6. Several shots go up in a single `ghmedia upload` call, each one fitted on its own.

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

The manual path still works, and is the escape hatch:

1. Create the PR first, body already written, media section still empty.
2. Chrome: `navigate` to the PR URL, `...` menu on the first comment, `Edit`.
3. Click the textarea, `cmd+Down` to reach the end, type the intro line.
4. `find` for "file input for attaching files in the comment editor". **Two refs come back**, the open editor and the "Add a comment" box at the bottom of the page. Take the one from the open editor, the other one puts the file in a new comment instead of the body.
5. `file_upload` with the paths. The markdown lands at the cursor by itself. If the path is rejected as not shared with the session, copy the file into the session scratchpad folder and upload from there.
6. `Update comment`, then confirm with `gh pr view --json body` that the `user-attachments` URL is in there.
