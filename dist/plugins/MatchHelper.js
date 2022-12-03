"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatchHelper = void 0;
const LobbyPlugin_1 = require("./LobbyPlugin");
const CommandParser_1 = require("../parsers/CommandParser");
const fs_1 = __importDefault(require("fs"));
const TypedConfig_1 = require("../TypedConfig");
const path_1 = __importDefault(require("path"));
class TeamInfo {
    constructor() {
        this.name = '';
        this.members = [];
    }
}
class TieBreakerInfo {
    constructor() {
        this.timer = 300;
        this.map = 0;
    }
}
class MatchMapInfo {
    constructor(id, name) {
        this.id = 0;
        this.name = '';
        this.id = id;
        this.name = name;
    }
}
class ScoreMultiplierInfo {
    constructor() {
        this.maps = new Map();
        this.players = new Map();
    }
}
class MatchInfo {
    constructor() {
        this.maps = new Map();
        this.timer = 120;
        this.bestOf = 5;
        this.maxBan = 2;
        this.tieBreaker = new TieBreakerInfo();
        this.customScoreMultipliers = new ScoreMultiplierInfo();
        this.teams = [];
        this.freeMod = [];
    }
}
class MatchHelper extends LobbyPlugin_1.LobbyPlugin {
    constructor(lobby, option = {}) {
        super(lobby, 'MatchHelper', 'matchHelper');
        this.match = new MatchInfo();
        this.tie = false;
        this.warmup = true;
        this.startPending = false;
        this.scoreUpdated = false;
        this.currentPick = '';
        this.currentPickTeam = 0;
        this.mapsChosen = [];
        this.mapsBanned = new Map();
        this.teamBanCount = new Map();
        this.startedPlayers = 0;
        this.finishedPlayers = 0;
        this.pointsToWin = 1;
        this.teamScore = new Map();
        this.matchScore = new Map();
        this.option = (0, TypedConfig_1.getConfig)(this.pluginName, option);
        this.loadMatch();
        if (this.option.enabled) {
            this.registerEvents();
        }
    }
    static getOrDefault(map, index, _default = 1) {
        if (!map.has(index)) {
            return _default;
        }
        else {
            return map.get(index);
        }
    }
    static increment(map, index, amount = 1) {
        if (!map.has(index)) {
            map.set(index, amount);
        }
        else {
            map.set(index, map.get(index) + amount);
        }
    }
    loadMatch() {
        const config = path_1.default.join('config', 'match.json');
        if (fs_1.default.existsSync(config)) {
            const match = JSON.parse(fs_1.default.readFileSync(config, 'utf8'));
            match.customScoreMultipliers.maps = new Map(Object.entries(match.customScoreMultipliers['maps']));
            match.customScoreMultipliers.players = new Map(Object.entries(match.customScoreMultipliers['players']));
            match.maps = new Map(Object.entries(match['maps']));
            this.pointsToWin = Math.ceil(match.bestOf / 2);
            for (const team of match.teams) {
                if (team.members.length === 1) {
                    team.name = team.members[0];
                }
            }
            this.match = match;
            this.resetMatchScore();
            this.logger.info('Loaded match config');
        }
        else {
            this.logger.warn('Match config does not exist');
        }
    }
    registerEvents() {
        this.lobby.ReceivedChatCommand.on(a => this.onReceivedChatCommand(a.command, a.param, a.player));
        this.lobby.PlayerChated.on(a => this.onPlayerChat(a.message, a.player));
        this.lobby.PlayerFinished.on(({ player, score }) => {
            if (this.warmup)
                return;
            const team = this.getPlayerTeam(player.name);
            if (!team) {
                return;
            }
            const multiplier = MatchHelper.getOrDefault(this.match.customScoreMultipliers.players, player.name);
            const effectiveScore = Math.round(score * multiplier);
            MatchHelper.increment(this.teamScore, team, effectiveScore);
            this.finishedPlayers++;
            this.logger.info(`Player finished: ${player.name}: ${multiplier === 1 ? score.toLocaleString('en-US') : `${score.toLocaleString('en-US')} x${multiplier} = ${effectiveScore.toLocaleString('en-US')}`} (${this.finishedPlayers} / ${this.startedPlayers})`);
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
            this.scoreUpdated = false;
            const players = Array.from(this.lobby.playersMap.keys());
            for (const team of this.match.teams) {
                this.teamScore.set(team, 0);
                for (const member of team.members) {
                    if (players.includes(member)) {
                        this.startedPlayers++;
                    }
                }
            }
            this.finishedPlayers = 0;
        });
        this.lobby.ReceivedBanchoResponse.on(a => {
            switch (a.response.type) {
                case CommandParser_1.BanchoResponseType.AllPlayerReady:
                    if (this.currentPick !== '' && !this.warmup && !this.startPending) {
                        this.lobby.SendMessage('所有选手已准备，比赛即将开始');
                        this.lobby.SendMessage('!mp start 10');
                        this.startPending = true;
                    }
                    break;
                case CommandParser_1.BanchoResponseType.TimerFinished:
                    if (this.currentPick === '' && !this.warmup) {
                        this.lobby.SendMessage(`计时超时，${this.match.teams[this.currentPickTeam].name} 队无选手选图`);
                        this.rotatePickTeam();
                    }
            }
        });
    }
    updateMatchScore() {
        if (this.scoreUpdated) {
            this.logger.warn('Match score change triggered more than once');
            return;
        }
        const teamScoreSorted = new Map([...this.teamScore.entries()].sort((a, b) => b[1] - a[1]));
        const scoreTeams = Array.from(teamScoreSorted.keys());
        const winner = scoreTeams[0];
        MatchHelper.increment(this.matchScore, winner, this.getMapMultiplier(this.currentPick));
        const teams = Array.from(this.matchScore.keys());
        const matchScore = Array.from(this.matchScore.values());
        const teamScores = Array.from(teamScoreSorted.values());
        this.lobby.SendMessage(`本轮 ${winner.name} 队以 ${(teamScores[0] - teamScores[1]).toLocaleString('en-US')} 分优势胜出`);
        const score1 = matchScore[0];
        const score2 = matchScore[1];
        this.lobby.SendMessage(`${teams[0].name}: ${score1} | ${score2}: ${teams[1].name}`);
        this.currentPick = '';
        this.scoreUpdated = true;
        if (score1 === score2 && score1 === this.pointsToWin - 1) {
            this.triggerTiebreaker();
        }
        else {
            for (let i = 0; i < matchScore.length; i++) {
                if (matchScore[i] === this.pointsToWin) {
                    this.lobby.SendMessage(`恭喜 ${teams[i].name} 队取得胜利`);
                    return;
                }
            }
        }
        this.rotatePickTeam();
    }
    triggerTiebreaker() {
        this.tie = true;
        this.lobby.SendMessage('即将进入TB环节');
        this.SendPluginMessage('changeMap', [this.match.tieBreaker.map.toString()]);
        this.setMod('FM');
        this.lobby.SendMessage('!mp aborttimer');
        this.lobby.SendMessage(`!mp timer ${this.match.tieBreaker.timer}`);
    }
    onPlayerChat(message, player) {
        const args = message.split(' ');
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
    onReceivedChatCommand(command, param, player) {
        switch (command) {
            case '!pick':
                this.processPick(param, player);
                break;
            case '!ban':
                this.processBan(param, player);
                break;
            case '!unban':
                if (player.isReferee && param.length > 2) {
                    param = param.toUpperCase();
                    if (this.mapsBanned.has(param)) {
                        const team = this.mapsBanned.get(param);
                        if (team) {
                            MatchHelper.increment(this.teamBanCount, team, -1);
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
                    }
                }
                break;
            case '!inviteall':
                if (player.isReferee) {
                    for (const team of this.match.teams) {
                        for (const player of team.members) {
                            this.lobby.SendMessage(`!mp invite ${player}`);
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
                if (player.name === 'PercyDan') {
                    this.loadMatch();
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
                                this.lobby.SendMessage(`请队伍 ${this.match.teams[this.currentPickTeam].name} 选手选图`);
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
    processPick(param, player) {
        if (param.length >= 2 && !this.tie) {
            param = param.toUpperCase();
            if (this.getPlayerTeam(player.name) !== this.match.teams[this.currentPickTeam] && !player.isReferee && !this.warmup) {
                this.lobby.SendMessage(`${player.name}: 没轮到你的队伍选图`);
                return;
            }
            const mod = param.slice(0, 2);
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
                this.setMod(mod);
                this.currentPick = map.name;
            }
            catch {
                this.lobby.SendMessage('Error: 未知错误，图可能不存在');
            }
        }
    }
    processBan(param, player) {
        const map = this.getMap(param);
        if (param.length > 2 && map !== null) {
            if (this.mapsBanned.has(map.name)) {
                return;
            }
            const team = this.getPlayerTeam(player.name);
            if (!team && !player.isReferee) {
                return;
            }
            if (team !== null && this.teamBanCount.get(team) >= this.match.maxBan) {
                this.lobby.SendMessage(`操作失败: 队伍 ${team?.name} ban已达到上限`);
                return;
            }
            this.mapsBanned.set(map.name, team);
            MatchHelper.increment(this.teamBanCount, team);
            this.lobby.SendMessage(`${!team?.name ? `裁判 ${player.name}` : team?.name} 已ban ${map.name}`);
        }
    }
    setMod(mod) {
        if (mod === 'NM') {
            this.lobby.SendMessage('!mp mods NF');
        }
        else if (this.match.freeMod.includes(mod)) {
            this.lobby.SendMessage('!mp mods FreeMod');
        }
        else {
            this.lobby.SendMessage(`!mp mods NF ${mod}`);
        }
    }
    resetPick() {
        this.currentPick = '';
        this.mapsChosen = [];
        this.mapsBanned.clear();
        this.teamBanCount.clear();
    }
    resetMatchScore() {
        this.tie = false;
        for (const team of this.match.teams) {
            this.matchScore.set(team, 0);
        }
    }
    getMap(param) {
        param = param.toUpperCase();
        const mod = param.slice(0, 2);
        const id = parseInt(param.substring(2)) - 1;
        if (id < 0 || !this.match.maps.has(mod) || this.match.maps.get(mod).length <= id) {
            this.lobby.SendMessage('操作失败:  图不存在');
            return null;
        }
        const maps = this.match.maps.get(mod);
        let map = maps[id];
        if (!map) {
            param += '1';
            map = maps[0];
            if (!map || maps.length > 1) {
                this.lobby.SendMessage('操作失败:  图不存在');
                return null;
            }
        }
        return new MatchMapInfo(map, param);
    }
    getMapMultiplier(param) {
        const mod = param.slice(0, 2);
        if (this.match.customScoreMultipliers.maps.has(param)) {
            return MatchHelper.getOrDefault(this.match.customScoreMultipliers.maps, param);
        }
        else {
            return MatchHelper.getOrDefault(this.match.customScoreMultipliers.maps, mod);
        }
    }
    rotatePickTeam() {
        if (this.tie) {
            return;
        }
        this.lobby.SendMessage(`!mp timer ${this.match.timer}`);
        this.currentPickTeam = (this.currentPickTeam + 1) % this.match.teams.length;
        this.lobby.SendMessage(`请队伍 ${this.match.teams[this.currentPickTeam].name} 选手选图`);
    }
    getPlayerTeam(player) {
        for (const team of this.match.teams) {
            if (team.members.includes(player)) {
                return team;
            }
        }
        return null;
    }
}
exports.MatchHelper = MatchHelper;
//# sourceMappingURL=MatchHelper.js.map