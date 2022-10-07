import {Lobby} from '../Lobby';
import {Player} from '../Player';
import {LobbyPlugin} from './LobbyPlugin';
import {BanchoResponseType} from '../parsers/CommandParser';

class MapInfo {
  Id: number;
  Mods: string;

  constructor(id: number, mods: string = 'NF') {
    this.Id = id;
    this.Mods = mods;
  }
}

export class MatchHelper extends LobbyPlugin {
  maps: MapInfo[] = [
    new MapInfo(1098594),
    new MapInfo(2050230),
    new MapInfo(797018),
    new MapInfo(2466610),
    new MapInfo(3558602),
    new MapInfo(1298998),
    new MapInfo(2822239),
    new MapInfo(1093605, 'HD'),
    new MapInfo(771858),
    new MapInfo(3692029),
    new MapInfo(1760024),
    new MapInfo(762507),
    new MapInfo(2335401, 'HD'),
    new MapInfo(553854, 'HD'),
    new MapInfo(3530438),
    new MapInfo(1820974),
    new MapInfo(1383338),
    new MapInfo(2814151),
    new MapInfo(3124768),
    new MapInfo(2130269),
    new MapInfo(114716),
    new MapInfo(1728826),
    new MapInfo(1505919),
    new MapInfo(440569, 'HD HR'),
    new MapInfo(19969, 'HR'),
    new MapInfo(181253),
  ];
  players: Map<string, number> = new Map<string, number>();
  matchScore: Map<string, number> = new Map<string, number>();
  mapChosenCount: Map<number, number> = new Map<number, number>();

  constructor(lobby: Lobby) {
    super(lobby, 'MatchHelper', 'matchHelper');
    this.registerEvents();
  }

  private registerEvents(): void {
    this.lobby.ReceivedChatCommand.on(a => this.onReceivedChatCommand(a.command, a.param, a.player));
    this.lobby.PlayerFinished.on(({player, score}) => {
      this.players.set(player.name, score);
      const playerCount = this.lobby.players.size;
      if (this.players.size === playerCount && playerCount === 2) {
        const sorted = new Map([...this.players.entries()].sort((a, b) => b[1] - a[1]));
        const players = Array.from(sorted.keys());
        const winner = players[0];
        this.increment(this.matchScore, winner);
        const other = players[1];
        if (!this.matchScore.has(other)) {
          this.matchScore.set(other, 0);
        }
        const matchPlayers = Array.from(this.matchScore.keys());
        const matchScore = Array.from(this.matchScore.values());
        const playerScore = Array.from(sorted.values());
        this.lobby.SendMessage(`本轮 ${winner} 以 ${(playerScore[0] - playerScore[1]).toLocaleString('en-US')} 分优势胜出`);
        this.lobby.SendMessage(`当前比分: ${matchPlayers[0]} ${matchScore[0]} - ${matchScore[1]} ${matchPlayers[1]}`);
      }
    });
    this.lobby.MatchStarted.on(() => {
      this.players.clear();
    });
    this.lobby.ReceivedBanchoResponse.on(a => {
      switch (a.response.type) {
        case BanchoResponseType.AllPlayerReady:
          this.lobby.SendMessage('所有选手已准备，比赛即将开始');
          this.lobby.SendMessage('!mp start 10');
          break;
      }
    });
  }

  private onReceivedChatCommand(command: string, param: string, player: Player) {
    if (player.isReferee) {
      if (command === '!map') {
        const mapCount = this.maps.length;
        let num;
        if (param === '') {
          let i = 0;
          while (true) {
            num = Math.floor(Math.random() * mapCount);
            i++;
            if (!this.mapChosenCount.has(num) || this.mapChosenCount.get(num)! <= 3 || i > 30) {
              break;
            }
          }
        } else {
          num = Number.parseInt(param);
        }
        if (!Number.isNaN(num) && num < mapCount) {
          this.changeMap(num);
        } else {
          this.lobby.SendMessage('Invalid map');
        }
      }

      if (command === '!resetscore') {
        this.matchScore.clear();
        this.lobby.SendMessage('Scores reset');
      }
    }
  }

  private changeMap(index: number) {
    const mapInfo = this.maps[index];
    this.lobby.SendMessage(`Changing map No.${index + 1}`);
    this.SendPluginMessage('changeMap', [mapInfo.Id.toString()]);
    this.increment(this.mapChosenCount, index);
    let mods = mapInfo.Mods;
    if (mods !== 'NF') {
      mods += ' NF';
    }
    this.lobby.SendMessage(`!mp mods ${mods}`);
  }

  private increment(map: Map<any, number>, index: any) {
    if (!map.has(index)) {
      map.set(index, 1);
    }
    else {
      map.set(index, map.get(index)! + 1);
    }
  }
}
