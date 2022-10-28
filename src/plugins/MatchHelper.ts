import {Lobby} from '../Lobby';
import {Player} from '../Player';
import {LobbyPlugin} from './LobbyPlugin';
import {BanchoResponseType} from '../parsers/CommandParser';
import fs from 'fs';
import {getConfig} from '../TypedConfig';

export interface MatchHelperOption {
  enable: boolean;
}

class TeamInfo {
  name: string = '';
  members: string[] = [];
}

export class MatchHelper extends LobbyPlugin {
  option: MatchHelperOption;
  maps: Map<string, number[]>;
  timer: number;
  teams: TeamInfo[] = [];
  currentPick: string = '';
  currentPickTeam: number = 0;
  mapsChosen: string[] = [];
  mapsBanned: string[] = [];
  finishedPlayers: number = 0;
  teamScore: Map<TeamInfo, number> = new Map<TeamInfo, number>();
  matchScore: Map<TeamInfo, number> = new Map<TeamInfo, number>();

  constructor(lobby: Lobby, option: Partial<MatchHelperOption> = {}) {
    super(lobby, 'MatchHelper', 'matchHelper');
    this.option = getConfig(this.pluginName, option) as MatchHelperOption;
    const settings = JSON.parse(fs.readFileSync('config\\match.json', 'utf8'));
    this.timer = settings['timer'];
    this.teams = settings['teams'];
    this.maps = new Map<string, number[]>(Object.entries(settings['maps']));
    if (this.option.enable) {
      this.registerEvents();
    }
  }

  private registerEvents(): void {
    this.lobby.ReceivedChatCommand.on(a => this.onReceivedChatCommand(a.command, a.param, a.player));
    this.lobby.PlayerFinished.on(({player, score}) => {
      const team = this.getPlayerTeam(player.name);
      this.increment(this.teamScore, team, score);
      const playerCount = this.lobby.players.size;
      this.finishedPlayers++;
      if (this.finishedPlayers === playerCount) {
        const sorted = new Map([...this.teamScore.entries()].sort((a, b) => b[1] - a[1]));
        const players = Array.from(sorted.keys());
        const winner = players[0];
        this.increment(this.matchScore, winner);
        const other = players[1];
        if (!this.matchScore.has(other)) {
          this.matchScore.set(other, 0);
        }
        const teams = Array.from(this.matchScore.keys());
        const matchScore = Array.from(this.matchScore.values());
        const teamScores = Array.from(sorted.values());
        this.lobby.SendMessage(`本轮 ${winner.name} 队以 ${(teamScores[0] - teamScores[1]).toLocaleString('en-US')} 分优势胜出`);
        this.lobby.SendMessage(`当前比分: ${teams[0].name} ${matchScore[0]} - ${matchScore[1]} ${teams[1].name}`);
      }
    });
    this.lobby.MatchStarted.on(() => {
      this.mapsChosen.push(this.currentPick);
      this.teamScore.clear();
      this.finishedPlayers = 0;
    });
    this.lobby.ReceivedBanchoResponse.on(a => {
      switch (a.response.type) {
        case BanchoResponseType.MatchFinished:
          this.currentPick = '';
          this.rotatePickTeam();
          break;
        case BanchoResponseType.TimerTimeout:
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
        if (param.length > 2) {
          if (!this.teams[this.currentPickTeam].members.includes(player.name)){
            this.lobby.SendMessage(`${player.name}: 没轮到你的队伍选图`);
            return;
          }
          const mod = param.slice(0, 2).toUpperCase();
          const map = this.getMap(param);
          if (map === null){
            return;
          }

          if (this.mapsBanned.includes(param)) {
            this.lobby.SendMessage('Error:  此图已被ban');
            return;
          }
          if (this.mapsChosen.includes(param) && !player.isReferee) {
            this.lobby.SendMessage('Error:  此图已经被选过');
            return;
          }

          try {
            this.SendPluginMessage('changeMap', [map]);
            if (mod === 'NM') {
              this.lobby.SendMessage('!mp mods NF');
            }
            else if (mod === 'FM') {
              this.lobby.SendMessage('!mp mods FreeMod');
            }
            else {
              this.lobby.SendMessage(`!mp mods NF ${mod}`);
            }
            this.currentPick = param;
          }
          catch {
            this.lobby.SendMessage('Error:  未知错误，图可能不存在');
          }
        }
        break;
      case '!ban':
        if (param.length > 2 && this.getMap(param) !== null){
          this.mapsBanned.push(param);
          this.lobby.SendMessage(`已ban ${param}`);
        }
        break;
      case '!unban':
        if (player.isReferee && param.length > 2){
          const index = this.mapsBanned.indexOf(param);
          if (index !== -1) {
            this.mapsBanned.splice(index, 1);
            this.lobby.SendMessage(`已移除ban ${param}`);
          }
        }
        break;
      case '!reset':
        if (player.isReferee) {
          this.mapsChosen = [];
          this.mapsBanned = [];
          this.matchScore.clear();
          this.lobby.SendMessage('已重置ban，pick和比分');
        }
        break;
      case '!setpickteam':
        if (player.isReferee && param !== '') {
          const team = Number.parseInt(param);
          if (Number.isInteger(team) && team < this.teams.length) {
            this.lobby.SendMessage(`!mp timer ${this.timer}`);
            this.currentPickTeam = team;
			this.lobby.SendMessage(`请队伍 ${this.teams[this.currentPickTeam].name} 选手选图`);
          }
        }
        break;
    }
  }

  private getMap(param: string): string | null {
    const mod = param.slice(0, 2).toUpperCase();
    const id = Number.parseInt(param.substring(2)) - 1;
    if (!this.maps.has(mod) || this.maps.get(mod)!.length <= id) {
      this.lobby.SendMessage('Error:  图不存在');
      return null;
    }
    return this.maps.get(mod)![id].toString();
  }

  private rotatePickTeam(){
    this.lobby.SendMessage(`!mp timer ${this.timer}`);
    this.currentPickTeam = (this.currentPickTeam + 1) % this.teams.length;
    this.lobby.SendMessage(`请队伍 ${this.teams[this.currentPickTeam].name} 选手选图`);
  }

  private getPlayerTeam(player: string): TeamInfo | null {
    for (const team of this.teams.values()) {
      if (team.members.includes(player)){
        return team;
      }
    }
    return null;
  }

  private increment(map: Map<any, number>, index: any, amount: number = 1) {
    if (!map.has(index)) {
      map.set(index, amount);
    }
    else {
      map.set(index, map.get(index)! + amount);
    }
  }
}
