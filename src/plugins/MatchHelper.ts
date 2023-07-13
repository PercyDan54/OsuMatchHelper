import { Lobby } from '../Lobby';
import { Player } from '../Player';
import { LobbyPlugin } from './LobbyPlugin';
import { BanchoResponseType } from '../parsers/CommandParser';
import fs from 'fs';
import { getConfig } from '../TypedConfig';
import path from 'path';
import { BaseClient } from 'kookts';
import { KookCardMessage, KookModule, KookText, Paragraph } from '../kook/KookMessage';
import { PlayerSettings } from '../parsers/MpSettingsParser';
import { checkCompatible, id, name } from '../libs/modUtils';

export interface MatchHelperOption {
  enabled: boolean;
  kook: {
    enabled: boolean,
    token: string,
    channelId: string,
  };
}

class TeamInfo {
  name: string = '';
  leader: string = '';
  members: string[] = [];
}

class TieBreakerInfo {
  timer: number = 300;
  map: number = 0;
}

class MatchMapInfo {
  id: number = 0;
  name: string = '';

  constructor(id: number, name: string) {
    this.id = id;
    this.name = name;
  }
}

class ScoreMultiplierInfo {
  maps: Map<string, number> = new Map<string, number>();
  mods: Map<string, number> = new Map<string, number>();
  teams: Map<string, number> = new Map<string, number>();
  players: Map<string, number> = new Map<string, number>();
}

class MatchInfo {
  name: string = '';
  timer: number = 120;
  rotateOnTimeout: boolean = true;
  bestOf: number = 5;
  maxBan: number = 2;
  referees: string[] = [];
  defaultMod: string = 'NF';
  customMods: Map<string, string> = new Map<string, string>();
  tieBreaker: TieBreakerInfo = new TieBreakerInfo();
  customScoreMultipliers: ScoreMultiplierInfo = new ScoreMultiplierInfo();
  maps: Map<string, number[]> = new Map<string, number[]>();
  activeTeams: string[] = [];
  teams: TeamInfo[] = [];
}

function getOrDefault(map: Map<any, any>, index: any, _default: any = 1): any {
  if (!map.has(index)) {
    return _default;
  } else {
    return map.get(index) as any;
  }
}

function increment(map: Map<any, number>, index: any, amount: number = 1) {
  if (!map.has(index)) {
    map.set(index, amount);
  } else {
    map.set(index, map.get(index) as number + amount);
  }
}

function parseMapId(input: string): [string, number | undefined] {
  const match = input.match(/(\D+)(\d+)?/);
  if (match === null) {
    return [input, undefined];
  }
  const [, mod, numString] = match;
  const num = numString ? parseInt(numString) : undefined;
  return [mod, num];
}

export class MatchHelper extends LobbyPlugin {
  option: MatchHelperOption;
  match: MatchInfo = new MatchInfo();
  tie: boolean = false;
  warmup: boolean = true;
  startPending: boolean = false;
  scoreUpdated: boolean = false;
  currentPick: string = '';
  currentPickTeam: number = 0;
  mapsChosen: string[] = [];
  mapsBanned: Map<string, TeamInfo> = new Map<string, TeamInfo>();
  teamBanCount: Map<TeamInfo, number> = new Map<TeamInfo, number>();
  startedPlayers: number = 0;
  finishedPlayers: number = 0;
  pointsToWin: number = 1;
  teamScore: Map<TeamInfo, number> = new Map<TeamInfo, number>();
  matchScore: Map<TeamInfo, number> = new Map<TeamInfo, number>();
  freeMod: boolean = false;
  kookClient: BaseClient | undefined;
  kookMessages: Map<TeamInfo, KookText[]> = new Map<TeamInfo, KookText[]>();

  constructor(lobby: Lobby, option: Partial<MatchHelperOption> = {}) {
    super(lobby, 'MatchHelper', 'matchHelper');
    this.option = getConfig(this.pluginName, option) as MatchHelperOption;
    if (this.option.kook.enabled) {
      this.kookClient = new BaseClient({
        mode: 'websocket',
        token: this.option.kook.token,
        logConfig: {level: 'warn'},
      });
    }
    this.loadMatch();
    if (this.option.enabled) {
      this.registerEvents();
    }
  }

  SetRefs() {
    for (const player of this.match.referees) {
      if (!this.lobby.GetPlayer(player)?.isReferee) {
        this.lobby.SendMessage(`!mp addref ${player}`);
      }
    }
  }

  private loadMatch() {
    const config = path.join('config', 'match.json');

    if (fs.existsSync(config)) {
      const match = JSON.parse(fs.readFileSync(config, 'utf8'));
      match.customMods = new Map<string, string>(Object.entries(match.customMods));
      match.customScoreMultipliers.maps = new Map<string, number>(Object.entries(match.customScoreMultipliers.maps));
      match.customScoreMultipliers.mods = new Map<string, number>(Object.entries(match.customScoreMultipliers.mods));
      match.customScoreMultipliers.teams = new Map<string, number>(Object.entries(match.customScoreMultipliers.teams));
      match.customScoreMultipliers.players = new Map<string, number>(Object.entries(match.customScoreMultipliers.players));
      match.maps = new Map<string, number[]>(Object.entries(match['maps']));
      this.pointsToWin = Math.ceil(match.bestOf / 2);
      const teams = new Map<string, TeamInfo>();

      for (const team of match.teams) {
        if (!team.leader) {
          team.leader = team.members[0];
        } else {
          team.members.push(team.leader);
        }

        if (team.members.length === 1) {
          team.name = team.members[0];
        }
        teams.set(team.name, team);
      }
      this.match = match;

      this.match.teams = [];
      for (const t of match.activeTeams) {
        if (teams.has(t)) {
          this.match.teams.push(teams.get(t) as TeamInfo);
        } else {
          this.logger.warn(`Team ${t} not found`);
        }
      }

      this.resetMatchScore();
      this.logger.info('Loaded match config');
    } else {
      this.logger.error('Match config does not exist');
    }

    if (this.kookClient) {
      this.kookClient.connect();
    }
  }

  private registerEvents(): void {
    this.lobby.ReceivedChatCommand.on(a => this.onReceivedChatCommand(a.command, a.param, a.player));
    this.lobby.PlayerChated.on(a => this.onPlayerChat(a.message, a.player));
    this.lobby.PlayerFinished.on(({player, score, isPassed}) => {
      if (this.warmup)
        return;

      const team = this.getPlayerTeam(player.name);
      if (!team) {
        return;
      }
      this.finishedPlayers++;
      if (!isPassed)
        return;

      let multiplier = getOrDefault(this.match.customScoreMultipliers.players, player.name);
      let multiplierText = '';
      if (multiplier !== 1) {
        multiplierText += `x${multiplier}`;
      }
      const teamMultiplier = getOrDefault(this.match.customScoreMultipliers.teams, this.getPlayerTeam(player.name)?.name);
      multiplier *= teamMultiplier;
      if (teamMultiplier !== 1) {
        multiplierText += ` x${teamMultiplier}`;
      }

      // Freemod custom mod score multiplier
      const playerOptions = this.getPlayerSettings(player.name)?.options ?? '';
      if (this.freeMod) {
        for (const mod of this.match.customScoreMultipliers.mods.keys()) {
          if (playerOptions.includes(mod)) {
            const modMultiplier = this.match.customScoreMultipliers.mods.get(mod) as number;
            multiplier *= modMultiplier;
            if (multiplier !== 1) {
              multiplierText += ` x${modMultiplier}`;
            }
          }
        }
      }

      const effectiveScore = Math.round(score * multiplier);
      increment(this.teamScore, team, effectiveScore);
      if (multiplier !== 1) {
        multiplierText += ` = ${effectiveScore.toLocaleString('en-US')}`;
      }

      const playerScoreText = `${score.toLocaleString('en-US')} ${multiplierText}`;
      this.logger.info(`${player.name}: ${playerScoreText} (${this.finishedPlayers} / ${this.startedPlayers})`);
      const kookText = this.kookMessages.get(team) as KookText[];
      kookText[0].content += `\n${player.name}`;
      kookText[1].content += `\n${playerScoreText}`;
      if (this.finishedPlayers >= this.startedPlayers) {
        this.updateMatchScore();
        this.startPending = false;
      }
    });
    this.lobby.MatchStarted.on(() => {
      if (this.warmup) {
        return;
      }

      this.mapsChosen.push(this.currentPick);
      this.teamScore.clear();
      this.startedPlayers = 0;
      this.finishedPlayers = 0;
      this.scoreUpdated = false;
      this.kookMessages.clear();
      if (this.freeMod) {
        this.lobby.LoadMpSettingsAsync().then();
      }

      const players = Array.from(this.lobby.players).map(p => p.name);
      for (const team of this.match.teams) {
        this.teamScore.set(team, 0);
        this.kookMessages.set(team, [new KookText('kmarkdown', '玩家'), new KookText('kmarkdown', '分数')]);
        for (const member of team.members) {
          if (players.includes(member)) {
            this.startedPlayers++;
          }
        }
      }
    });
    this.lobby.ReceivedBanchoResponse.on(a => {
      switch (a.response.type) {
        case BanchoResponseType.AllPlayerReady:
          if (this.currentPick !== '' && !this.warmup && !this.startPending) {
            this.lobby.SendMessage('所有选手已准备，比赛即将开始');
            this.lobby.SendMessage('!mp start 10');
            this.startPending = true;
          }
          break;
        case BanchoResponseType.AbortedMatch:
        case BanchoResponseType.AbortedStartTimer:
          this.startPending = false;
          break;
        case BanchoResponseType.TimerFinished:
          if (this.currentPick === '' && !this.warmup && !this.tie) {
            this.lobby.SendMessage(`计时超时，${this.match.teams[this.currentPickTeam].name} 队无选手选图`);
            if (this.match.rotateOnTimeout) {
              this.rotatePickTeam();
            }
          }
          break;
      }
    });
  }

  private updateMatchScore() {
    if (this.scoreUpdated) {
      this.logger.warn('Match score change triggered more than once');
      return;
    }

    const teamScoreSorted = new Map([...this.teamScore.entries()].sort((a, b) => b[1] - a[1]));
    const scoreTeams = Array.from(teamScoreSorted.keys());
    const winner = scoreTeams[0];
    increment(this.matchScore, winner, this.getMapMultiplier(this.currentPick));

    const teams = Array.from(this.matchScore.keys());
    const matchScore = Array.from(this.matchScore.values());
    const teamScores = Array.from(teamScoreSorted.values());

    const msg = new KookCardMessage();
    msg.modules.push(new KookModule('header', new KookText('plain-text', `玩家得分 - ${this.lobby.lobbyName}`)));
    for (let i = 0; i < scoreTeams.length; i++) {
      msg.modules.push(new KookModule('divider'));
      msg.modules.push(new KookModule('header', new KookText('plain-text', scoreTeams[i].name)));
      const paragraph = new Paragraph();
      const text = this.kookMessages.get(scoreTeams[i]) as KookText[];
      const formattedScore = teamScores[i].toLocaleString('en-US');
      text[0].content += `\n**总分: ${formattedScore}**`;
      paragraph.fields.push(text[0]);
      paragraph.fields.push(text[1]);
      msg.modules.push(new KookModule('section', paragraph));
      this.lobby.SendMessage(`${scoreTeams[i].name}: ${formattedScore}`);
    }

    let message = `本轮 ${winner.name} 队以 ${(teamScores[0] - teamScores[1]).toLocaleString('en-US')} 分优势胜出`;
    this.lobby.SendMessage(message);
    msg.modules.push(new KookModule('divider'));
    msg.modules.push(new KookModule('header', new KookText('plain-text', message)));
    if (this.currentPick !== '') {
      msg.modules.push(new KookModule('header', new KookText('plain-text', `${this.match.teams[this.currentPickTeam].name} 队选了 ${this.currentPick} (BID ${this.lobby.mapId})`)));
    } else if (this.tie) {
      msg.modules.push(new KookModule('header', new KookText('plain-text', `当前选图 TB (BID ${this.lobby.mapId})`)));
    }
    const score1 = matchScore[0];
    const score2 = matchScore[1];
    message = `${teams[0].name}: ${score1} | ${score2}: ${teams[1].name}`;
    this.lobby.SendMessage(message);
    msg.modules.push(new KookModule('divider'));
    msg.modules.push(new KookModule('header', new KookText('plain-text', `当前比分: ${message}`)));
    if (this.kookClient) {
      this.kookClient.Api.message.create(10, this.option.kook.channelId, JSON.stringify([msg])).then();
    }
    this.currentPick = '';
    this.scoreUpdated = true;

    if (score1 === score2 && score1 === this.pointsToWin - 1) {
      this.triggerTiebreaker();
    } else {
      for (let i = 0; i < matchScore.length; i++) {
        if (matchScore[i] === this.pointsToWin) {
          this.lobby.SendMessage(`恭喜 ${teams[i].name} 队取得胜利`);
          return;
        }
      }
      this.rotatePickTeam();
    }
  }

  private triggerTiebreaker() {
    this.tie = true;
    this.lobby.SendMessage('即将进入TB环节');
    this.SendPluginMessage('changeMap', [this.match.tieBreaker.map.toString()]);
    this.setMod('FM');
    this.lobby.SendMessage(`!mp timer ${this.match.tieBreaker.timer}`);
  }

  private onPlayerChat(message: string, player: Player) {
    const args = message.toLowerCase().split(' ');
    if (args.length > 1) {
      switch (args[0]) {
        case 'pick':
          this.processPick(args[1], player);
          break;
        case 'ban':
          this.processBan(args[1], player);
          break;
      }
    }
  }

  private onReceivedChatCommand(command: string, param: string, player: Player) {
    switch (command) {
      case '!pick':
        this.processPick(param, player);
        break;
      case '!ban':
        this.processBan(param, player);
        break;
      case '!noban':
        if (player.isReferee) {
          param = param.toUpperCase();
          if (this.mapsBanned.has(param)) {
            const team = this.mapsBanned.get(param);
            if (team) {
              increment(this.teamBanCount, team, -1);
            }
            this.mapsBanned.delete(param);
            this.lobby.SendMessage(`已移除ban ${param}`);
          }
        }
        break;
      case '!warmup':
        if (player.isReferee) {
          this.warmup = !this.warmup;
          this.lobby.SendMessage(`已切换热手状态: ${this.warmup}`);
          if (!this.warmup) {
            this.lobby.SendMessage('!mp clearhost');
            this.lobby.SendMessage('!mp set 2 3');
            this.lobby.SendMessageWithDelayAsync('提示：队长可以用pick/ban指令选图和ban图，如：“pick nm3”, “ban dt1” (不用引号)', 5000).then();
            const msg = new KookCardMessage();
            msg.modules.push(new KookModule('header', new KookText('plain-text', '比赛房间信息')));
            msg.modules.push(new KookModule('divider'));
            msg.modules.push(new KookModule('section', new KookText('kmarkdown', `房间名称: ${this.lobby.lobbyName}\n[mp链接](https://osu.ppy.sh/mp/${this.lobby.lobbyId})`)));
            if (this.kookClient) {
              this.kookClient.Api.message.create(10, this.option.kook.channelId, JSON.stringify([msg])).then();
            }
          }
        }
        break;
      case '!inviteall':
        if (player.isReferee) {
          const lobbyPlayers = Array.from(this.lobby.players).map(p => p.name);
          for (const team of this.match.teams) {
            for (const player of team.members) {
              if (!lobbyPlayers.includes(player)) {
                this.lobby.SendMessage(`!mp invite ${player}`);
              }
            }
          }
        }
        break;
      case '!reset':
        if (player.isReferee) {
          switch (param) {
            case 'pick':
              this.resetPick();
              break;
            case 'score':
              this.resetMatchScore();
              break;
            default:
              this.resetPick();
              this.resetMatchScore();
              break;
          }
          this.lobby.SendMessage('已重置');
        }
        break;
      case '!reload':
        if (player.name === this.lobby.ircClient.nick) {
          this.loadMatch();
        }
        break;
      case '!setrefs':
        if (player.isReferee || this.match.referees.includes(player.name)) {
          this.SetRefs();
        }
        break;
      case '!set':
        if (player.isReferee) {
          const args = param.split(' ');
          switch (args[0]) {
            case 'pick':
              if (args.length < 2) {
                return;
              }
              const team = parseInt(args[1]);
              if (Number.isInteger(team) && team < this.match.teams.length) {
                this.lobby.SendMessage(`!mp timer ${this.match.timer}`);
                this.currentPickTeam = team;
                this.lobby.SendMessage(`请队伍 ${this.match.teams[this.currentPickTeam].name} 队长选图`);
              }
              break;
            case 'score':
              if (args.length < 3) {
                return;
              }
              const score1 = parseInt(args[1]);
              const score2 = parseInt(args[2]);
              if (Number.isInteger(score1) && Number.isInteger(score2)) {
                const scores = [score1, score2];
                const teams = Array.from(this.matchScore.keys());
                for (let i = 0; i < teams.length; i++) {
                  this.matchScore.set(teams[i], scores[i]);
                }
              }
          }
        }
        break;
      case '!trigger':
        if (player.isReferee) {
          switch (param) {
            case 'score':
              this.updateMatchScore();
              break;
            case 'tb':
              this.triggerTiebreaker();
          }
        }
        break;
    }
  }

  private processPick(param: string, player: Player) {
    const leader = this.isLeader(player.name);

    param = param.toUpperCase();
    if (!leader && !player.isReferee || (this.tie && !player.isReferee)) {
      return;
    }
    if (!this.warmup && leader !== this.match.teams[this.currentPickTeam] && !player.isReferee) {
      this.lobby.SendMessage(`${player.name}: 没轮到你的队伍选图`);
      return;
    }
    const map = this.getMap(param);
    if (!map) {
      return;
    }
    if (Array.from(this.mapsBanned.keys()).includes(map.name)) {
      this.lobby.SendMessage('操作失败: 此图已被ban');
      return;
    }
    if (this.mapsChosen.includes(map.name) && !player.isReferee) {
      this.lobby.SendMessage('操作失败: 此图已经被选过');
      return;
    }
    try {
      this.SendPluginMessage('changeMap', [map.id.toString()]);
      this.setMod(parseMapId(map.name)[0]);
      this.currentPick = map.name;
    } catch {
      this.lobby.SendMessage('Error: 未知错误，图可能不存在');
    }
  }

  private processBan(param: string, player: Player) {
    const map = this.getMap(param);
    if (map) {
      if (this.mapsBanned.has(map.name)) {
        return;
      }

      const team = this.isLeader(player.name);
      if (!team && !player.isReferee) {
        return;
      }

      if (team && this.teamBanCount.get(team) as number >= this.match.maxBan) {
        this.lobby.SendMessage(`操作失败: 队伍 ${team?.name} ban已达到上限`);
        return;
      }

      this.mapsBanned.set(map.name, team as TeamInfo);
      increment(this.teamBanCount, team);
      this.lobby.SendMessage(`${team?.name ? team?.name : `裁判 ${player.name}`} 已ban ${map.name}`);
    }
  }

  private setMod(mods: string) {
    for (const s of this.match.customMods.entries()) {
      if (s[1] === 'FreeMod' && mods.includes(s[0])) {
        this.freeMod = true;
        this.lobby.SendMessage('!mp mods FreeMod');
        return;
      }
      mods = mods.replace(s[0], s[1]);
    }
    const defaultId = id(this.match.defaultMod);
    let modNumber = id(mods);
    modNumber &= ~defaultId;
    const compat = checkCompatible(modNumber | defaultId, modNumber);
    const compatibleModsString = compat === 0 ? this.match.defaultMod : name(compat);
    let modString = '';
    for (let i = 0; i < compatibleModsString.length; i += 2) {
      modString += `${compatibleModsString.slice(i, i + 2)} `;
    }
    modString = modString.replace('RX', 'Relax');
    this.lobby.SendMessage(`!mp mods ${modString}`);
  }

  private resetPick() {
    this.currentPick = '';
    this.mapsChosen = [];
    this.mapsBanned.clear();
    this.teamBanCount.clear();
  }

  private resetMatchScore() {
    this.tie = false;
    this.matchScore.clear();
    for (const team of this.match.teams) {
      this.matchScore.set(team, 0);
    }
  }

  private getMap(param: string): MatchMapInfo | null {
    param = param.toUpperCase();
    const split = parseMapId(param);
    const mod = split[0];
    if (!split[1]) {
      split[1] = 1;
      param += '1';
    }
    const id = split[1] - 1;

    if (id < 0 || !this.match.maps.has(mod) || (this.match.maps.get(mod) as number[]).length <= id) {
      this.lobby.SendMessage('操作失败:  图不存在');
      return null;
    }

    const maps = this.match.maps.get(mod) as number[];
    const map = maps[id];
    if (!map) {
      return null;
    }
    return new MatchMapInfo(map, param);
  }

  private getMapMultiplier(param: string): number {
    const mod = parseMapId(param)[0];
    if (this.match.customScoreMultipliers.maps.has(param)) {
      return getOrDefault(this.match.customScoreMultipliers.maps, param);
    } else {
      return getOrDefault(this.match.customScoreMultipliers.maps, mod);
    }
  }

  private rotatePickTeam() {
    this.lobby.SendMessage(`!mp timer ${this.match.timer}`);
    this.currentPickTeam = (this.currentPickTeam + 1) % this.match.teams.length;
    this.lobby.SendMessage(`请队伍 ${this.match.teams[this.currentPickTeam].name} 队长选图`);
  }

  private isLeader(player: string): TeamInfo | null {
    for (const team of this.match.teams) {
      if (team.leader === player) {
        return team;
      }
    }
    return null;
  }

  private getPlayerTeam(player: string): TeamInfo | null {
    for (const team of this.match.teams) {
      if (team.members.includes(player)) {
        return team;
      }
    }
    return null;
  }

  private getPlayerSettings(player: string): PlayerSettings | null {
    const playerSettings = this.lobby.settingParser.result;
    if (playerSettings) {
      for (const player1 of playerSettings.players) {
        if (player1.name === player) {
          return player1;
        }
      }
    }
    return null;
  }
}
