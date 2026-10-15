# TubePilot

A free MCP server that lets Claude manage your YouTube channel. No credits and no subscription. It talks straight to Google's free YouTube APIs using your own login key.

## What Claude can do with it

| Area | Tools |
|---|---|
| Channel | `my_channel`, `update_channel` (description, keywords), `set_banner` |
| Videos | `list_videos`, `get_video`, `upload_video`, `update_video`, `set_thumbnail`, `delete_video` |
| Playlists | `list_playlists`, `create_playlist`, `add_to_playlist`, `remove_from_playlist` |
| Comments | `list_comments`, `reply_comment`, `moderate_comment`, `delete_comment` |
| Analytics | `analytics` (views, watch time, retention, subs, traffic sources, countries…) |
| Quota | `quota_status`, which tracks today's free 10,000 units so uploads don't fail halfway |

## Setup (one time)

You need [Node.js](https://nodejs.org) 18 or newer, plus the OAuth JSON you downloaded from Google Cloud (Desktop app client).

```bash
git clone https://github.com/Hybridash/TubePilot.git
cd TubePilot
npm install
npm link            # makes the `tubepilot` command work anywhere
tubepilot setup "C:\Users\you\Downloads\client_secret_XXXX.json"
```

`setup` copies the key into `~/.tubepilot/` and opens Google's login in your browser. Pick the account that owns your channel. Google will say the app isn't verified. Click **Advanced → Go to TubePilot (unsafe)**. That warning is normal, because it's your own app. After this you can delete the downloaded JSON.

### Connect it to Claude

**Claude Code:**
```bash
claude mcp add tubepilot -- node "C:\full\path\to\TubePilot\dist\index.js"
```

**Claude desktop app:** go to Settings → Developer → Edit Config and add:
```json
{
  "mcpServers": {
    "tubepilot": {
      "command": "node",
      "args": ["C:\\full\\path\\to\\TubePilot\\dist\\index.js"]
    }
  }
}
```
Then restart the app.

## Things to know

- **Quota:** you get 10,000 units a day for free, and it resets at midnight Pacific time. Most actions cost 1 to 50 units, and an upload costs about 1,600, so you get roughly 6 uploads a day.
- **Uploads are locked private** until your Google project passes YouTube's free [API audit](https://support.google.com/youtube/contact/yt_api_form). Until then, upload through YouTube Studio, or upload with TubePilot and request the audit.
- **Weekly re-login:** while your Google app is in "Testing" mode, the login expires after 7 days. Run `tubepilot login` again, or publish the app under Google Auth Platform → Audience to stop that.
- **Custom thumbnails** need a phone-verified channel (youtube.com/verify).
- **No API exists** for community posts or monetization settings.

Your login key and token stay on your computer in `~/.tubepilot/`. Never commit them.
