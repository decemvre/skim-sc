# Skim Bot

Keeps SkiM SC current and tells the group chat what is on: today's Korean Brood War matches
and news, in English, with players under their IDs and nicknames - never their real names.
Runs on Silviu's machine; posts through the Friendzy WhatsApp bridge.

Ask it in the group: `/skim <question>` in Romanian or English (F-287). The bridge reads only
messages that start with /skim; `bot/ask.mjs` has Claude Haiku search the Korean sources and
answers in the group in the question's language - at any hour, at most 15 an hour and 60 a day; the first question over a limit is told when to ask again.
`/skim help` (`/skim ajutor` in Romanian, or a bare `/skim`) answers with what the bot can do,
written in `helpText()` rather than by the model, and is not counted against the limits (F-344).

- `node bot/matches.mjs` - SOOP's official schedule -> `bot/data/matches.json`; names matched
  against Liquipedia once and kept in `bot/data/names.json` (edit it by hand to correct one).
- `node --test bot/test/*.test.mjs` - the tests.

No dependencies beyond Node 24 and Google Chrome (to read SOOP's schedule page).

## YouTube links in the group (F-535)

A YouTube link posted in the group (watch, youtu.be, /shorts, m., music.) comes back as a Digi Cloud
link to the video: `bot/video.mjs`, run by the bridge once per link, one at a time and apart from
/skim questions. Of a message that is not /skim the bridge reads only its YouTube URLs, never its
text, and never the bot's own messages.

- yt-dlp at 720p at most, mp4, H.264 first. Not saved, with a short note: over 2 h, over 2 GB, a
  live stream.
- Uploaded to Digi Cloud, folder `Skim videos` (made the first time; nothing else in the account
  is touched), and a public link made to it: anyone with the link can watch or download it, no
  login; it is listed nowhere. The reply: who posted it, the title, the link on its own line.
- The same video again (by id) gets the same link. At most 20 stay in the folder: the oldest by
  upload time go, links and all.
- The local copy (`~/.cache/skim-bot/videos/`) is deleted after the upload, or after the last
  retry failed. Retries double from 30 s with jitter, capped at 8 min; 3 tries to download, 4 to
  upload. A failure for good is one short note in the group.
- Login: `~/.config/friendzy/digistorage.json` (mode 600) `{"user": "<email>", "password": "<app password>"}`.
  Without it a link gets "could not be saved just now".

    node bot/video.mjs --download-only -- <url>   # the download alone, then deleted: no login
    node bot/video.mjs --no-post -- <url>         # everything, the reply printed, not sent

## How it runs (O-98)

`bot/run.mjs` is one pass of everything; a systemd user timer runs it every 15 minutes from
the bot's own clone in `~/.local/share/skim-bot/skim-sc` (so its commits never collide with work
in another checkout). It pulls, refreshes the schedule hourly, checks the news every half hour,
asks the model (Claude, Grok as fallback) only when news is queued - weekdays 07:30-16:00, at
most 8 times a day - adds results after 20:00, publishes the page when something changed, and
posts to the group only between 08:00 and 16:00 Bucharest time.

    cp bot/systemd/skim-bot.* ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now skim-bot.timer
    journalctl --user -u skim-bot -f

The group: `~/.config/friendzy/skim-bot.json` `{"group": "<exact WhatsApp group name>"}`, and the
same name under `"groups"` in `~/.config/friendzy/whatsapp-bridge.json`. Until both are set,
posts are logged, not sent.

Rules for the group (Silviu): nothing outside 08:00-16:00; one morning post; news as it comes
on weekdays; never news on weekends - only major matches; reminders before major matches; no
results, but one kind: a match between star-university teams, posted once its result is known
(12 Oct), any day. Every other result lives on the page behind a closed dropdown.
