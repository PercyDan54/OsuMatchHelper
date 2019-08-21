# osu-ahr memo

## 概要
OSUのマルチゲームにて、ホストローテーションを自動化するためのボット
Osu-Auto-Host-Rotation

## 処理の流れ初期案
- BanchoBot宛に!mp make [roomname]を送る、その返信から部屋番号をユーザーに通知する
- 作った部屋のchannel(#mp_[roomid]) に入る
- ロビー監視モード
  - if ユーザーが入ってきたら B([userid] joined in slot [slot].)
    - if 誰もいないなら /その人をホストにする
    - else /ホストキューに追加
  - if ユーザーが出ていったら B([userid] left the game.)
    - if ホストなら
      - if 誰かいるなら /次のホストを任命
    - else
      - キューから削除
    - if 誰もいないなら
      - タイマーで部屋を削除 
  - if ホストが選曲したら B(Beatmap changed to) /AFK検知タイマー停止
  - if ホストが変更されたら B([userid] became the host.)
      - if ホストキューと違う人が任命されたら /正しい人に変更
  - if ホストが部屋サイズ変更したら -> 検出できないかも
  - if ホストがキックしたら -> どうしよう
  - if B(All players are ready) -> 未準備の人が抜けると発生しないかもなので注意
  - if B(The match has started!) /ゲーム監視モード
- ゲーム監視モード
  - if ユーザーが入ってきたら B([userid] joined in slot [slot].)
    - /ホストキューに追加? 今のホストのあとに追加するべき？
  - if ユーザーが出ていったら B([userid] left the game.)
    - /ホストキューから削除
    - if キューが空なら /!mp abortでロビー削除タイマー
  - if プレイヤースコア B([userid] finished playing) 
    - /完了リストに追加 -> 完了リストいる？ 未所持で試合が始まった場合はここに乗らない
    - /試合終了タイマー（最後のプレイヤーが終了してから１０秒後に強制終了）
  - if 試合終了 B(The match has finished!) /試合終了処理
- 試合終了時の処理
  - 現在のホストをキューに追加
  - キューの先頭をホストに任命
  - 試合終了タイマーのキャンセル
  - 完了リストとホストキューを突き合わせる（監視開始前にプレイヤーがいた場合や、未想定の事態に備えて）
- lobbyが生きたままahrのプロセスが終了した場合に備えて、復帰機構をつける
  - 開始時に設定を保存、再開時にそのlobbyにアクセスを試みる。正常終了時に設定を削除
  - もしくは単純にユーザーにlobbyidを入力してもらう

## 構成
- IIrcClient : IRCクライアントのインターフェース、mockを作るため
- ILobby : BanchoBotとのテキストのやり取りを抽象化
- LobbyPlugin : ILobbyを介して、各種機能を実現する

## AutoHostSelector class 設計 
### 概要
オートホストローテーション機能を行うためLobbyPlugin
ILobbyのイベントに対して処理を行う
### 状態
<dl>
  <dt>S0</dt>
  <dd>初期状態。hostQueueが空</dd>
  <dt>S1</dt>
  <dd>ホスト未選択状態。hostQueueが空ではない。currentHostがnull</dd>
  <dt>H</dt>
  <dd>試合開始待ち状態。currentHostがnullでない</dd>
  <dt>M</dt>
  <dd>試合中。isMatchingがtrue</dd>
</dl>

### 状態遷移と動作
s0
- PlayerJoined
  - キューに追加して、!mp hostを発行。s1へ遷移
s1
- PlayerJoined
  - キューに追加
- PlayerLeft
  - キューから削除
  - キューが０人ならs0へ遷移
  - 先頭が変わったら!mp hostを再発行
- HostChanged (起こりうる？)
  - 先頭が対象ならHへ遷移
  - それ以外なら!mp hostを再発行
- MatchStarted
  - !mp abortを発行

H
- PlayerJoined
  - キューに追加
- PlayerLeft
  - キューから削除
  - キューが０人ならs0へ遷移
  - 先頭が変わったら!mp hostを再発行しS1へ遷移
- HostChanged
  - 前のホストを末尾に移動
  - 先頭が対象ならそのまま
  - それ以外なら!mp hostを再発行しS1へ遷移
- MatchStarted
  - 現在のhostをキューの末尾へ
  - Mへ遷移 

M 
- PlayerJoined
  - キューに追加
- PlayerLeft
  - キューから削除
  - 0人にはならないはず。
- MatchFinished
  - 次のホストを任命してS1へ遷移

## npm スクリプト
- build distフォルダを削除 -> srcをtscでコンパイル
- start
 ~~src/index.js を実行~~ 
 ts-node から tsファイルを直接実行する
- test testsフォルダの単体テストをmochaで実行する

## 注意
IRCでチャットを取得するには!mp make から部屋を作らないといけない。
!mp makeで部屋を作るとホストが抜けた場合、ホストが別の人に映らず誰もホストでない状態になる。

ライブラリ irc をインストールする際にエラーが出るが、文字コード識別機能を使わなければ問題ないらしい。
でも他のパッケージをインストールする際にエラーがでてインストール出来ない場合がある。
一旦ircを削除して、入れ直す？

## Irc と osuマルチロビーについて
IRCはOsuのゲーム内チャットのすべてに干渉できるわけではない。権限が異なるっぽい。
IRCで接続できるのは!mp make で作成したトーナメントロビーだけ
トーナメントロビーのIRCにはプレイヤーが参加していないがチャットメッセージは受信できる

## test用 dummy class
テストのたびにマルチロビー作るのはまずいので、ダミーのIRCクライアントを作る。

要求
IRC機能
  join
  part
  say
  
イベント
  Registered IRC接続時
  Join ロビー入室時
  Part ロビー退出時
  Message メッセージ受信

Banchobot機能
  プレイヤー入室
  プレイヤー退出
  ホストがマップ変更
  試合 -> 開始メッセージ、プレイヤー終了、試合終了

## コンフィグ
サーバーパスワードなどをgitに公開するのはまずいのでconfigモジュールで管理する。
configモジュールは現在のNODE_ENV環境変数により適切なjsonコンフィグファイルを選択してロードしてくれる。NODE_ENVが指定されていない場合はDevelopmentが使用され、Developmentが存在しない場合はdefaultが使用される。共通項目はdefault.jsonに記述。production.jsonとdevelopment.jsonに非公開情報を記述し、この2つをgitignoreに追加。

# usernameルール
banchobotのメッセージからユーザー名を抜き出すための正規表現を作る際に、
公式のusername要件が必要になったので調べた。
[github](https://github.com/ppy/osu-web/blob/master/app/Libraries/UsernameValidation.php)
### ルール
- ^[A-Za-z0-9-\[\]_ ]+$#u
- 名前の前後のスペースはだめ
- 3文字以上、15文字以下
- スペースを2つ以上続けてはだめ
- _ とスペースは同時に使えない

## logging
ログからプレイヤーのチャットを抜き出す正規表現
^([^@]*@msg\s+)(?!BanchoBot)\w+.*$

## ロビーヒストリーWebApi
下記url形式で時系列のイベントと関連したユーザーの情報が取得できる。
必要ならこれらの情報も解析して利用したい。

https://osu.ppy.sh/community/matches/54000487/history?after=1255711787&limit=100

# TASK
## todo
- 試合がスタックした場合のabort投票。abort時のホスト切り替え（始まる前にスタックしたか、終了時にスタックしたか） => 一人でもmatch finishedなら切り替え。

## wip

## done
- スキップ後に自動で変更されないことがあった　修正済み
- abort後に ismatching フラグを折り忘れていた　修正済み
- キューの先頭にゴミが付く 修正
- mp settings で名前に[] が入るプレイヤーを正しく認識できない 修正済み
- /skip機能の追加 hostなら即変更、それ以外なら投票で変更　
- host skip timer機能　
- host skipperの表示が投票0でも退出時に表示されてしまう。修正済み
- cliのdisplayの誤字とエラー　修正済み
- log4jsのコンフィグは起動時書き換えを有効にするために独立したファイルにしたほうがいい。
- プレイヤーのチャット専用のログファイルがほしい。
- auth2のプレイヤーがホストのときに/skipしても即スキップにならない
- ユーザーがいなくなったときにエラーが発生
-  ホストが試合中に抜けると順番がおかしくなる.キューの並び替えタイミングを変更 
- ロビーが空になった際の自動クローズ
- ホストのスキップ時間が迫ったときに警告文を出すか、チャットしたときにタイマーが再設定されるようにする
- 誰もいない状態で!mp settingsしたときにどうなるか？ -> players: 0で打ち切り
- スキップ時にたまりすぎる問題 -> クールタイムを設けた
- ロビーに入って!mp settingsで情報を取得した際に、ホストからスロット順で並ぶようにする