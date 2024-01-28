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
import { checkCompatible, id, name } from '../libs/ModUtils';
import { MatchHelperApi } from './MatchHelperApi';

export interface MatchHelperOption {
  enabled: boolean;
  kook: {
    enabled: boolean,
    token: string,
    channelId: string,
  };
}

abstract class MatchInfoBase {
  multiplier: number = 1;
  name: string = '';
}

class TeamInfo extends MatchInfoBase {
  leader: Player = new Player('');
  members: PlayerInfo[] = [];
}

class PlayerInfo extends MatchInfoBase {
  id: number = 0;
}

class MapInfo extends MatchInfoBase {
  id: number = 0;
  mods: string = '';

  constructor(id: number, name: string, mods: string, multiplier: number = 1) {
    super();
    this.id = id;
    this.name = name;
    this.mods = mods;
    this.multiplier = multiplier;
  }
}

class MappoolInfo extends MatchInfoBase {
  mods: string | undefined;
  maps: number[] = [];

  constructor(maps: number[]) {
    super();
    this.maps = maps;
  }
}

class ScoreMultiplierInfo {
  mods: Map<string, number> = new Map<string, number>();
}

class MatchInfo {
  name: string = '';
  timer: number = 120;
  rotateOnTimeout: boolean = true;
  bestOf: number = 5;
  maxBan: number = 2;
  teamSize: number = 3;
  referees: string[] = [];
  defaultMod: string = 'NF';
  players: Map<string, PlayerInfo> = new Map<string, PlayerInfo>();
  tieBreaker: { timer: number, map: number } = { timer: 0, map: 0 };
  customScoreMultipliers: ScoreMultiplierInfo = new ScoreMultiplierInfo();
  maps: Map<string, MappoolInfo> = new Map<string, MappoolInfo>();
  activeTeams: string[] = [];
  teams: TeamInfo[] = [];
  allTeams: TeamInfo[] = [];
  mapRolls: Map<string, number> = new Map<string, number>();
  mapBaseScores: Map<string, number> = new Map<string, number>();
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
  currentPick: MapInfo | null = null;
  currentPickTeam: number = 0;
  mapsChosen: string[] = [];
  mapsBanned: Map<string, TeamInfo> = new Map<string, TeamInfo>();
  teamBanCount: Map<TeamInfo, number> = new Map<TeamInfo, number>();
  startedPlayers: number = 0;
  finishedPlayers: number = 0;
  pointsToWin: number = 1;
  teamScore: Map<TeamInfo, number> = new Map<TeamInfo, number>();
  matchScore: Map<TeamInfo, number> = new Map<TeamInfo, number>();
  teamRolls: Map<string, number> = new Map<string, number>();
  freeMod: boolean = false;
  kookClient: BaseClient | undefined;
  kookMessages: Map<TeamInfo, KookText[]> = new Map<TeamInfo, KookText[]>();
  webApi: MatchHelperApi = new MatchHelperApi(this);

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
      //this.webApi.StartServer(3333);
    }
  }

  private loadMatch() {
    const config = path.join('config', 'match.json');

    if (fs.existsSync(config)) {
      const match = JSON.parse(fs.readFileSync(config, 'utf8'));
      match.customScoreMultipliers.mods = new Map<string, number>(Object.entries(match.customScoreMultipliers.mods));
      match.maps = new Map<string, MappoolInfo[]>(Object.entries(match.maps));
      match.mapBaseScores = new Map<string, number>(Object.entries(match.mapBaseScores));
      match.mapRolls = new Map<string, number>(Object.entries(match.mapRolls));
      match.players = new Map<string, PlayerInfo>();
      this.pointsToWin = Math.ceil(match.bestOf / 2);
      match.allTeams = match.teams;

      const mapPools = Array.from(match.maps.entries()) as any[];
      for (const entry of mapPools) {
        const name = entry[0];
        const pool = entry[1];
        if (Array.isArray(pool)) {
          match.maps.set(name, new MappoolInfo(pool));
        }
      }

      for (const team of match.allTeams) {
        for (let i = 0; i < team.members.length; i++) {
          const member = team.members[i];
          if (typeof member === 'string') {
            team.members[i] = new Player(member);
          }
        }

        if (!team.leader) {
          team.leader = team.members[0];
        } else {
          if (typeof team.leader === 'string') {
            team.leader = new Player(team.leader);
          }
          team.members.push(team.leader);
        }

        for (let i = 0; i < team.members.length; i++) {
          const member = team.members[i];
          match.players.set(team.members[i].name, team.members[i]);
        }

        if (team.members.length === 1) {
          team.name = team.members[0].name;
        }
      }

      this.match = match;
      this.loadTeams();
      this.logger.info('Loaded match config');
    } else {
      this.logger.error('Match config does not exist');
    }

    if (this.kookClient) {
      this.kookClient.connect();
    }
  }

  private loadTeams() {
    const teams = new Map<string, TeamInfo>();

    for (const team of this.match.allTeams) {
      teams.set(team.name, team);
    }

    this.match.teams = [];
    for (const t of this.match.activeTeams) {
      if (teams.has(t)) {
        this.match.teams.push(teams.get(t) as TeamInfo);
      } else {
        this.logger.warn(`Team ${t} not found`);
      }
    }
    this.resetMatchScore();
  }

  private registerEvents(): void {
    this.lobby.ircClient.on('selfMessage', (target, message) => this.webApi.pendingMessages.push({username: this.lobby.ircClient.nick, text: message, date: new Date().toISOString()}));
    this.lobby.ReceivedChatCommand.on(a => this.onReceivedChatCommand(a.command, a.param, a.player));
    this.lobby.PlayerChated.on(a => this.onPlayerChat(a.message, a.player));
    this.lobby.PlayerFinished.on(({player, score, isPassed}) => {
      if (this.warmup)
        return;

      const player1 = this.getPlayer(player.name);
      if (!player1) {
        return;
      }
      const team = this.getPlayerTeam(player.name) as TeamInfo;

      this.finishedPlayers++;
      if (!isPassed)
        return;

      let multiplier = player1.multiplier ?? 1;
      let multiplierText = '';
      if (multiplier !== 1) {
        multiplierText += `x${multiplier}`;
      }

      const teamMultiplier = team?.multiplier ?? 1;
      multiplier *= teamMultiplier;
      if (teamMultiplier !== 1) {
        multiplierText += ` x${teamMultiplier}`;
      }

      // Freemod custom mod score multiplier
      const playerOptions = this.getPlayerSettings(player)?.options ?? '';
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

      if (this.currentPick) {
        this.mapsChosen.push(this.currentPick.name);
      }
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
          if (players.includes(member.name)) {
            this.startedPlayers++;
          }
        }
      }

      this.logger.log(this.startedPlayers === this.match.teamSize * 2 ? 'info' : 'warn', `Match started with ${this.startedPlayers} players`);
    });
    this.lobby.ParsedSettings.on(a => {
      for (const player of a.result.players) {
        for (let i = 0; i < this.match.teams.length; i++) {
          const t = this.match.teams[i];
          for (let i1 = 0; i1 < t.members.length; i1++) {
            const member = t.members[i1];
            if (member.id === player.id) {
              const name = member.name;
              const newName = player.name;
              if (name !== newName) {
                this.match.teams[i].members[i1].name = newName;
                this.match.players.delete(name);
                this.match.players.set(newName, this.match.teams[i].members[i1]);
                this.logger.info(`Player #${member.id} name changed ${name} -> ${newName}`);
              }
            }
          }
        }
      }
    });
    this.lobby.ReceivedBanchoResponse.on(a => {
      switch (a.response.type) {
        case BanchoResponseType.AllPlayerReady:
          if (this.currentPick && !this.warmup && !this.startPending) {
            if (this.freeMod) {
              this.lobby.SendMessage('所有选手已准备');
              this.lobby.ParsedSettings.once(() => {
                const noNF: string[] = [];
                let problem = false;
                const players = Array.from(this.lobby.players).map(p => p.name);
                for (const team of this.match.teams) {
                  let needsHidden = true;
                  let needsHardRock = true;
                  for (const member of team.members) {
                    if (!players.includes(member.name)){
                      continue;
                    }
                    const playerSettings = this.getPlayerSettings(member);
                    const mods = playerSettings?.options.split(' / ')[1] ?? '';
                    if (!mods.includes('NoFail'))
                      noNF.push(member.name);
                    if (mods.includes('Hidden')){
                      needsHidden = false;
                    }
                    if (mods.includes('HardRock')){
                      needsHardRock = false;
                    }
                  }
                  let msg = `队伍 ${team.name} 缺少`;
                  if (needsHidden) {
                    msg += ' HD';
                  }
                  if (needsHardRock) {
                    msg += ' HR';
                  }
                  if ((needsHidden || needsHardRock) && !this.tie) {
                    problem = true;
                    msg += ' 选手';
                    this.lobby.SendMessage(msg);
                  }
                }
                if (noNF.length > 0) {
                  problem = true;
                  this.lobby.SendMessage(`以下选手缺少NF： ${noNF.join(', ')}`);
                }
                if (problem) {
                  this.lobby.SendMessage('由于以上问题，比赛未开始，请检查');
                  return;
                }
                this.lobby.SendMessage('!mp start 7');
                this.startPending = true;
              });
              this.lobby.SendMessage('!mp settings');
              return;
            }
            this.lobby.SendMessage('所有选手已准备，比赛即将开始');
            this.lobby.SendMessage('!mp start 7');
            this.startPending = true;
          }
          break;
        case BanchoResponseType.AbortedMatch:
        case BanchoResponseType.AbortedStartTimer:
          this.startPending = false;
          break;
        case BanchoResponseType.TimerFinished:
          if (!this.currentPick && !this.warmup && !this.tie) {
            this.lobby.SendMessage(`计时超时，${this.match.teams[this.currentPickTeam].name} 队无选手选图`);
            if (this.match.rotateOnTimeout) {
              this.rotatePickTeam();
            }
          }
          break;
        case BanchoResponseType.Rolled:
          if (this.currentPick || this.tie) {
            const team = this.getPlayerTeam(a.response.params[0]);
            const point = a.response.params[1] as number;
            if (team && point <= this.getMapRoll(this.currentPick) && !this.teamRolls.has(team.name)) {
              this.logger.info(`Team ${team.name} set to ${point}`);
              this.teamRolls.set(team.name, point);
              if (this.teamRolls.size === 2) {
                this.sendTargetScore();
              }
            }
          }
          break;
      }
    });
  }

  private sendRoll() {
    this.lobby.SendMessageWithDelayAsync(`本图roll点：${this.getMapRoll(this.currentPick)} | 基准分数: ${(this.getMapBaseScore(this.currentPick) * 10000).toLocaleString('en-US')}`, 4000).then();
  }

  private sendTargetScore() {
    this.lobby.SendMessage(`目标分数：${this.getBaseScore().toLocaleString('en-US')}`);
  }

  private getBaseScore() {
    let sum = 0;

    for (const v of this.teamRolls.values()) {
      sum += v;
    }
    return this.getMapBaseScore(this.currentPick) * 10000 + sum * 5000;
  }

  private getMapBaseScore(map: MapInfo | null): number {
    if (!map) return 0;
    if (this.match.mapRolls.has(map.name)) {
      return getOrDefault(this.match.mapBaseScores, map.name, 50);
    } else {
      return getOrDefault(this.match.mapBaseScores, map.mods, 50);
    }
  }

  private getMapRoll(map: MapInfo | null): number {
    if (!map) return 0;
    if (this.match.mapRolls.has(map.name)) {
      return getOrDefault(this.match.mapRolls, map.name, 200);
    } else {
      return getOrDefault(this.match.mapRolls, map.id, 200);
    }
  }

  private updateMatchScore() {
    if (this.scoreUpdated) {
      this.logger.warn('Match score change triggered more than once');
      return;
    }

    const baseScore = this.getBaseScore();
    for (const t of this.teamScore.entries()) {
      this.teamScore.set(t[0], Math.abs(t[1] - baseScore));
    }

    const teamScoreSorted = new Map([...this.teamScore.entries()].sort((a, b) => a[1] - b[1]));
    const scoreTeams = Array.from(teamScoreSorted.keys());
    const winner = scoreTeams[0];
    increment(this.matchScore, winner, this.currentPick?.multiplier ?? 1);

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

    let message = `本轮 ${winner.name} 队以 ${(teamScores[1] - teamScores[0]).toLocaleString('en-US')} 分优势胜出`;
    this.lobby.SendMessage(message);
    msg.modules.push(new KookModule('divider'));
    msg.modules.push(new KookModule('header', new KookText('plain-text', message)));
    if (this.currentPick) {
      msg.modules.push(new KookModule('header', new KookText('plain-text', `${this.match.teams[this.currentPickTeam].name} 队选了 ${this.currentPick.name} (BID ${this.lobby.mapId})`)));
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
    this.currentPick = null;
    this.scoreUpdated = true;
    this.freeMod = false;
    this.teamRolls.clear();

    if (score1 === score2 && score1 === this.pointsToWin - 1) {
      this.triggerTiebreaker();
    } else {
      for (let i = 0; i < matchScore.length; i++) {
        if (matchScore[i] === this.pointsToWin) {
          this.lobby.SendMessageWithDelayAsync(`恭喜 ${teams[i].name} 队取得胜利`, 3000);
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
    this.currentPick = new MapInfo(this.match.tieBreaker.map, 'TB', 'FreeMod');
    this.lobby.SendMessage(`!mp timer ${this.match.tieBreaker.timer}`);
  }

  private onPlayerChat(message: string, player: Player) {
    this.webApi.pendingMessages.push({username: player.name, text: message, date: new Date().toISOString()});
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
    this.webApi.pendingMessages.push({username: player.name, text: `${command} ${param}`, date: new Date().toISOString()});
    switch (command) {
      case '!pick':
        this.processPick(param, player);
        break;
      case '!ban':
        this.processBan(param, player);
        break;
      case '!noban':
      case '!unban':
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
          const msg = [];
          for (const team of this.match.teams) {
            for (const player of team.members) {
              if (!lobbyPlayers.includes(player.name)) {
                let playerStr = player.name;
                if (player.id > 0)
                  playerStr = `#${player.id}`;
                msg.push(`!mp invite ${playerStr}`);
              }
            }
          }
          this.lobby.SendMultilineMessageWithInterval(msg, 3000, 'invite', 0).then();
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
      case 'setrefs':
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
              break;
            case 'roll':
              if (args.length < 3) {
                return;
              }
              const s1 = parseInt(args[1]);
              const s2 = parseInt(args[2]);
              if (Number.isInteger(s1) && Number.isInteger(s2)) {
                const scores = [s1, s2];
                const teams = Array.from(this.matchScore.keys());
                for (let i = 0; i < teams.length; i++) {
                  this.teamRolls.set(teams[i].name, scores[i]);
                }
                this.sendTargetScore();
              }
              break;
            case 'teams':
              if (args.length < 3) {
                return;
              }
              this.match.activeTeams = [args[1], args[2]];
              this.loadTeams();
              break;
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
    const leader = this.isLeader(player);

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
      this.setMod(map.mods);
      this.currentPick = map;
      this.sendRoll();
    } catch {
      this.lobby.SendMessage('Error: 未知错误，图可能不存在');
    }
  }

  SetRefs() {
    for (const player of this.match.referees) {
      if (!this.lobby.GetPlayer(player)?.isReferee) {
        this.lobby.SendMessage(`!mp addref ${player}`);
      }
    }
  }

  private processBan(param: string, player: Player) {
    const map = this.getMap(param);
    if (map) {
      if (this.mapsBanned.has(map.name)) {
        return;
      }

      const team = this.isLeader(player);
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
    let modString = '';
    if (mods === 'FreeMod') {
      this.freeMod = true;
      modString = mods;
    }
    else {
      const defaultId = id(this.match.defaultMod);
      let modNumber = id(mods);
      modNumber &= ~defaultId;
      const compat = checkCompatible(modNumber | defaultId, modNumber);
      const compatibleModsString = compat === 0 ? this.match.defaultMod : name(compat);
      for (let i = 0; i < compatibleModsString.length; i += 2) {
        modString += `${compatibleModsString.slice(i, i + 2)} `;
      }
      modString = modString.replace('RX', 'Relax');
    }
    this.lobby.SendMessage(`!mp mods ${modString}`);
  }

  private resetPick() {
    this.currentPick = null;
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

  private getMap(param: string): MapInfo | null {
    param = param.toUpperCase();
    const split = parseMapId(param);
    const mod = split[0];
    if (!split[1]) {
      split[1] = 1;
      param += '1';
    }
    const id = split[1] - 1;

    if (id < 0 || !this.match.maps.has(mod) || (this.match.maps.get(mod) as MappoolInfo).maps.length <= id) {
      this.lobby.SendMessage('操作失败:  图不存在');
      return null;
    }

    const pool = this.match.maps.get(mod) as MappoolInfo;
    const maps = pool.maps as number[];
    const map = maps[id];
    if (!map) {
      return null;
    }
    return new MapInfo(map, param, pool.mods ?? mod, pool.multiplier ?? 1);
  }

  private rotatePickTeam() {
    this.lobby.SendMessage(`!mp timer ${this.match.timer}`);
    this.currentPickTeam = (this.currentPickTeam + 1) % this.match.teams.length;
    this.lobby.SendMessage(`请队伍 ${this.match.teams[this.currentPickTeam].name} 队长选图`);
  }

  private isLeader(p: PlayerInfo | Player): TeamInfo | null {
    for (const team of this.match.teams) {
      if (team.leader.name === p.name || (team.leader.id === p.id && p.id)) {
        return team;
      }
    }
    return null;
  }

  private getPlayer(player: string): PlayerInfo | null {
    return this.match.players.get(player) ?? null;
  }

  private getPlayerTeam(p: string): TeamInfo | null {
    for (const team of this.match.teams) {
      for (const member of team.members) {
        if (member.name === p)
          return team;
      }
    }
    return null;
  }

  private getPlayerSettings(player: PlayerInfo | Player): PlayerSettings | null {
    const playerSettings = this.lobby.settingParser.result;
    if (playerSettings) {
      for (const player1 of playerSettings.players) {
        if (player1.name === player.name || player1.id === player.id) {
          return player1;
        }
      }
    }
    return null;
  }
}
