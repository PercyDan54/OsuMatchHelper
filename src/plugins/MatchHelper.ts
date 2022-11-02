import { Lobby } from '../Lobby';
import { Player } from '../Player';
import { LobbyPlugin } from './LobbyPlugin';
import { BanchoResponseType } from '../parsers/CommandParser';
import fs from 'fs';
import { getConfig } from '../TypedConfig';
import path from 'path';

export interface MatchHelperOption {
  enabled: boolean;
}

class TeamInfo {
  name: string = '';
  members: string[] = [];
}

class TieBreakerInfo {
  timer: number = 300;
  map: number = 0;
}

export class MatchHelper extends LobbyPlugin {
  option: MatchHelperOption;
  maps: Map<string, number[]> = new Map<string, number[]>();
  timer: number = 120;
  bestOf: number = 5;
  maxBan: number = 2;
  tie: boolean = false;
  warmup: boolean = false;
  tieBreaker: TieBreakerInfo = new TieBreakerInfo();
  teams: TeamInfo[] = [];
  currentPick: string = '';
  currentPickTeam: number = 0;
  mapsChosen: string[] = [];
  mapsBanned: Map<string, TeamInfo | null> = new Map<string, TeamInfo>();
  teamBanCount: Map<TeamInfo, number> = new Map<TeamInfo, number>();
  startedPlayers: number = 0;
  finishedPlayers: number = 0;
  teamScore: Map<TeamInfo, number> = new Map<TeamInfo, number>();
  matchScore: Map<TeamInfo, number> = new Map<TeamInfo, number>();

  constructor(lobby: Lobby, option: Partial<MatchHelperOption> = {}) {
    super(lobby, 'MatchHelper', 'matchHelper');
    this.option = getConfig(this.pluginName, option) as MatchHelperOption;
    this.loadMatch();
    if (this.option.enabled) {
      this.registerEvents();
    }
  }

  private loadMatch() {
    const match = JSON.parse(fs.readFileSync(path.join('config', 'match.json'), 'utf8'));
    this.timer = match['timer'];
    this.teams = match['teams'];
    this.bestOf = match['bestOf'];
    this.tieBreaker = match['tieBreaker'];
    this.maxBan = match['ban'];
    this.maps = new Map<string, number[]>(Object.entries(match['maps']));
  }

  private registerEvents(): void {
    this.lobby.ReceivedChatCommand.on(a => this.onReceivedChatCommand(a.command, a.param, a.player));
    this.lobby.PlayerFinished.on(({player, score}) => {
      if (this.warmup)
        return;

      const team = this.getPlayerTeam(player.name);
      this.increment(this.teamScore, team, score);
      this.finishedPlayers++;

      if (this.finishedPlayers === this.startedPlayers && this.finishedPlayers > 1) {
        const sorted = new Map([...this.teamScore.entries()].sort((a, b) => b[1] - a[1]));
        const players = Array.from(sorted.keys());
        const winner = players[0];
        this.increment(this.matchScore, winner, this.currentPick.startsWith('EX') ? 2 : 1);
        const other = players[1];

        this.increment(this.matchScore, other, 0);

        const teams = Array.from(this.matchScore.keys());
        const matchScore = Array.from(this.matchScore.values());
        const teamScores = Array.from(sorted.values());

        this.lobby.SendMessage(`本轮 ${winner.name} 队以 ${(teamScores[0] - teamScores[1]).toLocaleString('en-US')} 分优势胜出`);
        const score1 = matchScore[0];
        const score2 = matchScore[1];
        this.lobby.SendMessage(`${teams[0].name} ${score1} - ${score2} ${teams[1].name}`);

        this.currentPick = '';
        this.rotatePickTeam();

        if (score1 === score2 && score1 === this.bestOf - 1) {
          this.tie = true;
          this.lobby.SendMessage('即将进入TB环节');
          this.SendPluginMessage('changeMap', [this.tieBreaker.map.toString()]);
          this.setMod('FM');
          this.lobby.SendMessage('!mp timer abort');
          this.lobby.SendMessage(`!mp timer ${this.tieBreaker.timer}`);
        }
      }
    });
    this.lobby.MatchStarted.on(() => {
      if (this.warmup) {
        return;
      }
      this.mapsChosen.push(this.currentPick);
      this.teamScore.clear();
      this.startedPlayers = this.lobby.players.size;
      this.finishedPlayers = 0;
    });
    this.lobby.ReceivedBanchoResponse.on(a => {
      switch (a.response.type) {
        case BanchoResponseType.AllPlayerReady:
          if (this.currentPick !== '' || this.warmup) {
            this.lobby.SendMessage('所有选手已准备，比赛即将开始');
            this.lobby.SendMessage('!mp start 10');
          }
          break;
        case BanchoResponseType.TimerFinished:
          if (this.currentPick === '') {
            this.lobby.SendMessage(`计时超时，${this.teams[this.currentPickTeam].name} 队无选手选图`);
            this.rotatePickTeam();
          }
      }
    });
  }

  private onReceivedChatCommand(command: string, param: string, player: Player) {
    switch (command) {
      case '!pick':
        if (param.length >= 2 && !this.tie) {
          if (!this.teams[this.currentPickTeam].members.includes(player.name) && !player.isReferee && !this.warmup) {
            this.lobby.SendMessage(`${player.name}: 没轮到你的队伍选图`);
            return;
          }

          const mod = param.slice(0, 2).toUpperCase();
          const map = this.getMap(param);
          if (map === null) {
            return;
          }

          if (Array.from(this.mapsBanned.keys()).includes(param)) {
            this.lobby.SendMessage('Error:  此图已被ban');
            return;
          }
          if (this.mapsChosen.includes(param) && !player.isReferee) {
            this.lobby.SendMessage('Error:  此图已经被选过');
            return;
          }

          try {
            this.SendPluginMessage('changeMap', [map]);
            this.setMod(mod);
            this.currentPick = param;
          } catch {
            this.lobby.SendMessage('Error:  未知错误，图可能不存在');
          }
        }
        break;
      case '!ban':
        if (param.length > 2 && this.getMap(param) !== null) {

          if (this.mapsBanned.has(param)) {
            return;
          }

          const team = this.getPlayerTeam(player.name);
          this.mapsBanned.set(param, team);

          if (team === null && !player.isReferee) {
            return;
          }

          if (this.teamBanCount.get(<TeamInfo>team)! >= this.maxBan) {
            this.lobby.SendMessage(`Error: 队伍 ${team?.name} ban已达到上限`);
          }
          this.increment(this.teamBanCount, team);
          this.lobby.SendMessage(`${team?.name} 已ban ${param}`);
        }
        break;
      case '!unban':
        if (player.isReferee && param.length > 2) {
          if (this.mapsBanned.has(param)) {
            const team = this.mapsBanned.get(param);
            if (team !== null) {
              this.increment(this.teamBanCount, team, -1);
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
        }
        break;
      case '!reset':
        if (player.isReferee) {
          switch (param) {
            case 'pick':
              this.resetPick();
              break;
            case 'score':
              this.matchScore.clear();
              break;
            default:
              this.resetPick();
              this.matchScore.clear();
              this.tie = false;
              break;
          }
          this.lobby.SendMessage('已重置');
        }
        break;
      case '!reload':
        if (player.name === 'PercyDan') {
          this.logger.info('Reloaded');
          this.loadMatch();
        }
        break;
      case '!setpickteam':
        if (player.isReferee) {
          const team = parseInt(param);
          if (Number.isInteger(team) && team < this.teams.length) {
            this.lobby.SendMessage(`!mp timer ${this.timer}`);
            this.currentPickTeam = team;
            this.lobby.SendMessage(`请队伍 ${this.teams[this.currentPickTeam].name} 选手选图`);
          }
        }
        break;
    }
  }

  private setMod(mod: string) {
    if (mod === 'NM') {
      this.lobby.SendMessage('!mp mods NF');
    } else if (mod === 'FM') {
      this.lobby.SendMessage('!mp mods FreeMod');
    } else {
      this.lobby.SendMessage(`!mp mods NF ${mod}`);
    }
  }

  private resetPick() {
    this.mapsChosen = [];
    this.mapsBanned.clear();
    this.teamBanCount.clear();
  }

  private getMap(param: string): string | null {
    const mod = param.slice(0, 2).toUpperCase();
    const id = parseInt(param.substring(2)) - 1;
    if (!this.maps.has(mod) || this.maps.get(mod)!.length <= id) {
      this.lobby.SendMessage('Error:  图不存在');
      return null;
    }
    return this.maps.get(mod)![id].toString();
  }

  private rotatePickTeam() {
    if (this.tie) {
      return;
    }
    this.lobby.SendMessage(`!mp timer ${this.timer}`);
    this.currentPickTeam = (this.currentPickTeam + 1) % this.teams.length;
    this.lobby.SendMessage(`请队伍 ${this.teams[this.currentPickTeam].name} 选手选图`);
  }

  private getPlayerTeam(player: string): TeamInfo | null {
    for (const team of this.teams) {
      if (team.members.includes(player)) {
        return team;
      }
    }
    return null;
  }

  private increment(map: Map<any, number>, index: any, amount: number = 1) {
    if (!map.has(index)) {
      map.set(index, amount);
    } else {
      map.set(index, map.get(index)! + amount);
    }
  }
}
