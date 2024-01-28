
# OsuMatchHelper

IRC bot for osu tournament lobby management based on the [osu-ahr](https://github.com/Meowhal/osu-ahr) project

The original README can be found [here](https://github.com/PercyDan54/OsuMatchHelper/blob/MatchHelper/README-ahr.md)

# Setup and most configurations

See [here](https://github.com/PercyDan54/OsuMatchHelper/blob/MatchHelper/README-ahr.md#Setup)

# Configuration

## MatchHelper Section

Plugin for tournament lobby management

```JSON
  "MatchHelper": {
    "enabled": true,
    "kook": {
      "enabled": false,
      "token": "",
      "channelId": ""
    }
  },
```

+ `enabled` : `boolean` Set true if you want to enable
+ `kook` : Kook message options
    + enabled  => Enable kook messages
    + token => Kook bot token
    + channelId => Channel ID to send messages

## match.json file

A valid example is provided in the config folder.

# Running

Run once on every update, including the first run:
> npm run build

After joining the lobby the bot is in warmup state by default and will not do any score calculations.
Use `!warmup` command to change.

# Commands
## Referee Commands

| Command                               | Description                                                                     | Example          |
|:--------------------------------------|:--------------------------------------------------------------------------------|:-----------------|
| `!warmup`                             | Toggle the warmup state.                                                        |                  |
| `!inviteall`                          | Invites all players for the current match.                                      |                  |
| `!noban [map]`                        | Unban a map banned by the player.                                               | `!noban NM2`     |
| `!trigger tb`                         | Picks the TieBreaker map.                                                       |                  |
| `!set score [red score] [blue score]` | Changes the match score.                                                        | `!set score 2 3` |
| `!set pick [team]`                    | Changes the map picking team. Team can be 0 or 1, representing red / blue team. | `!set pick 1`    |
