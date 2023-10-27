import express from 'express';
import { Server } from 'http';
import { MatchHelper } from './MatchHelper';

export class MatchHelperApi {
  matchHelper: MatchHelper;
  pendingMessages: object[] = [];

  constructor(matchHelper: MatchHelper) {
    this.matchHelper = matchHelper;
  }

  public StartServer(port: number): Server {
    const app = express();
    app.use(express.text());
    app.use(express.json());

    const server = app.listen(port, '0.0.0.0', () => {
      this.matchHelper.logger.info(`Server running at http://localhost:${port}/`);
    });

    app.get('/api/close', (req, res, next) => {
      server.close();
    });
    app.get('/api/ping', (req, res, next) => {
      const lobbyName = this.matchHelper.lobby.lobbyName;
      if (!lobbyName || lobbyName === '__') {
        res.json({lobby_name: null});
      }
      else{
        res.json({lobby_name: lobbyName});
      }
    });
    app.get('/api/message', (req, res, next) => {
      res.json(this.pendingMessages);
      this.pendingMessages = [];
    });
    app.post('/api/message', (req, res, next) => {
      if (!(req.body as string))
        return;
      this.matchHelper.lobby.SendMessage(req.body);
    });

    process.on('exit', (code) => {
      server.close();
    });

    return server;
  }
}
