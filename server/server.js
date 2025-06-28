const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const wss = new WebSocket.Server({ port: 8080 });

// DB初期化
const dbPath = path.resolve(__dirname, 'ranking.db');
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS historical_winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    time REAL,
    hash_count INTEGER, -- ★ここを追加：ハッシュ計算回数
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error("歴代勝者DB作成エラー:", err);
    else console.log("historical_winnersテーブルが準備できました。");
  });
});

// ゲームの状態管理
let gameState = {
  status: 'idle', // 'idle', 'countdown', 'mining', 'finished'
  winner: null, // { username, time }
  countdownSeconds: 5,
  // players: 接続中の全プレイヤー情報 (ws.username, ws.role, latestNonce, latestHash, connected, baseDataForMining)
  players: new Map(),
  currentMiningParticipants: new Map(), // 今回のマイニングゲームに参加したプレイヤーの情報 (username, time, hashCount, isWinner)
};

function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// 歴代ランキングを特定のWSクライアントに送信する関数
function sendHistoricalRanking(ws) {
  // ★ここを変更：hash_count も取得
  db.all(`SELECT username, time, hash_count FROM historical_winners ORDER BY time ASC LIMIT 10`, (err, rows) => {
    if (err) {
      console.error("歴代ランキング取得エラー:", err);
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ranking', data: rows }));
    }
  });
}

// 全てのクライアントに歴代ランキングをブロードキャストする関数
function broadcastHistoricalRanking() {
  // ★ここを変更：hash_count も取得
  db.all(`SELECT username, time, hash_count FROM historical_winners ORDER BY time ASC LIMIT 10`, (err, rows) => {
    if (err) {
      console.error("歴代ランキング取得エラー:", err);
      return;
    }
    broadcast(JSON.stringify({ type: 'ranking', data: rows }));
  });
}


function sendAdminState() {
  wss.clients.forEach(client => {
    if (client.role === 'admin' && client.readyState === WebSocket.OPEN) {
      const playersArray = Array.from(gameState.players.entries()).map(([username, data]) => ({
        username: username,
        latestNonce: data.latestNonce,
        latestHash: data.latestHash,
        connected: data.connected
      }));
      client.send(JSON.stringify({ type: 'player_list', players: playersArray }));
      client.send(JSON.stringify({ type: 'state', state: gameState.status }));
    }
  });
}

function startGame() {
  // ゲームの状態をリセット
  gameState.winner = null;
  gameState.currentMiningParticipants.clear(); // 今回の参加者ランキングをクリア

  // 各プレイヤーのマイニング進捗とbaseDataをリセットし、新しいbaseDataを生成してクライアントに通知
  wss.clients.forEach(client => {
    if (client.role === 'player' && client.readyState === WebSocket.OPEN) {
      const playerEntry = gameState.players.get(client.username);
      if (playerEntry) {
        playerEntry.latestNonce = 0; // nonceを0にリセット
        playerEntry.latestHash = '-';
        playerEntry.baseDataForMining = client.username + Date.now() + Math.random(); // 新しいbaseDataを生成
        client.send(JSON.stringify({
          type: 'game_start_info',
          baseData: playerEntry.baseDataForMining,
          nonce: playerEntry.latestNonce
        }));
      }
    }
  });

  gameState.status = 'countdown';
  broadcast(JSON.stringify({ type: 'state', state: gameState.status }));
  console.log('ゲーム開始カウントダウン開始');

  let secondsLeft = gameState.countdownSeconds;
  const countdownInterval = setInterval(() => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'countdown', secondsLeft: secondsLeft }));
        }
    });
    secondsLeft--;

    if (secondsLeft < 0) {
      clearInterval(countdownInterval);
      gameState.status = 'mining';
      broadcast(JSON.stringify({ type: 'state', state: gameState.status }));
      console.log('マイニング開始！');
    }
  }, 1000);
}

function resetGame() {
  // 1. 全てのクライアントに最新の歴代ランキングを送信
  broadcastHistoricalRanking();

  // 2. 管理者以外の参加者を切断し、状態をリセット
  wss.clients.forEach(client => {
    if (client.role !== 'admin' && client.readyState === WebSocket.OPEN) {
      console.log(`プレイヤー ${client.username || '未登録'} を切断します。`);
      // クライアント側に切断を促すメッセージ
      client.send(JSON.stringify({ type: 'game_reset' }));
      // 標準的なクローズコード1000 (Normal Closure) と理由
      client.close(1000, "Game Reset by Admin");
    }
  });

  // 3. ゲーム状態をリセット
  gameState.winner = null;
  gameState.status = 'idle'; // アイドル状態に戻す
  gameState.currentMiningParticipants.clear();
  
  // playersマップ内の connected 状態を更新
  // 切断されたプレイヤーについては connected: false に設定し、latestNonce/Hash/baseDataもリセット
  // 管理者はそのまま維持しつつ、マイニングデータはリセット
  const playersToRemove = [];
  gameState.players.forEach((playerData, username) => {
      let foundConnectedWs = false;
      wss.clients.forEach(client => {
          if (client.username === username && client.readyState === WebSocket.OPEN) {
              foundConnectedWs = true;
          }
      });

      if (!foundConnectedWs) {
          // 接続されていないプレイヤーはマップから削除
          playersToRemove.push(username);
      } else {
          // 接続中のプレイヤー（管理者など）はデータだけリセット
          playerData.latestNonce = '-';
          playerData.latestHash = '-';
          playerData.baseDataForMining = '-'; // baseDataもリセット
          playerData.connected = true; // 念のためconnectedをtrueに
      }
  });

  playersToRemove.forEach(username => gameState.players.delete(username));


  // 管理者画面に更新されたプレイヤーリストを送信
  sendAdminState();
  // ゲーム状態のブロードキャスト (これは管理者画面に主に影響)
  broadcast(JSON.stringify({ type: 'state', state: gameState.status }));


  console.log('ゲームがリセットされました。');
}


wss.on('connection', ws => {
  console.log('新しい接続');

  // 接続時に歴代ランキングを送信
  sendHistoricalRanking(ws);

  // 既存のゲーム状態を送信
  ws.send(JSON.stringify({ type: 'state', state: gameState.status }));

  // 既に勝者がいて、かつゲームが終了状態の場合、接続時に終了画面の情報を送信
  if (gameState.winner && gameState.status === 'finished') {
    ws.send(JSON.stringify({
      type: 'winner',
      winner: { username: gameState.winner.username, time: gameState.winner.time },
      allParticipants: Array.from(gameState.currentMiningParticipants.values())
    }));
  }


  ws.on('message', message => {
    const data = JSON.parse(message);

    if (data.type === 'register') {
      ws.username = data.username;
      ws.role = data.role || 'player';

      let playerEntry = gameState.players.get(ws.username);
      if (playerEntry) {
        // 既存プレイヤーの再接続
        playerEntry.connected = true;
        playerEntry.role = ws.role;

        // プレイヤーに現在のnonceとbaseDataを通知
        if (playerEntry.baseDataForMining) {
          ws.send(JSON.stringify({
            type: 'game_start_info', // タイプ名を変更して、これはゲーム開始情報であると明確に
            baseData: playerEntry.baseDataForMining,
            nonce: playerEntry.latestNonce
          }));
        } else {
            // baseDataがまだない場合（最初の接続など）、新しく生成して通知
            playerEntry.baseDataForMining = ws.username + Date.now() + Math.random();
            playerEntry.latestNonce = 0; // 最初は0
            ws.send(JSON.stringify({
              type: 'game_start_info',
              baseData: playerEntry.baseDataForMining,
              nonce: playerEntry.latestNonce
            }));
        }
      } else {
        // 新規プレイヤー
        playerEntry = {
          latestNonce: '-',
          latestHash: '-',
          connected: true,
          role: ws.role,
          baseDataForMining: ws.username + Date.now() + Math.random() // 新しいbaseDataを生成
        };
        gameState.players.set(ws.username, playerEntry);

        // 新規プレイヤーにもbaseDataとnonceを通知
        ws.send(JSON.stringify({
          type: 'game_start_info',
          baseData: playerEntry.baseDataForMining,
          nonce: playerEntry.latestNonce
        }));
      }
      console.log(`登録: ${ws.username} (役割: ${ws.role})`);
      sendAdminState();

    } else if (data.type === 'start_game' && ws.role === 'admin') {
      if (gameState.status === 'idle' || gameState.status === 'finished') {
        startGame();
      } else {
        console.log('ゲームは既に開始されていますか、カウントダウン中です。');
      }
    } else if (data.type === 'reset_game' && ws.role === 'admin') {
      console.log('管理者からのゲームリセットコマンドを受信しました。');
      resetGame();
    }
    else if (data.type === 'player_progress' && ws.role === 'player') {
      const player = gameState.players.get(ws.username);
      // マイニング中のプレイヤーの進捗のみ受け入れる
      if (player && gameState.status === 'mining') { 
        player.latestNonce = data.nonce;
        player.latestHash = data.hash; // ハッシュ値も保存
        
        // currentMiningParticipants にプレイヤーを追加/更新
        gameState.currentMiningParticipants.set(ws.username, {
          username: ws.username,
          time: gameState.currentMiningParticipants.get(ws.username)?.time || null, // 既存の時間を保持
          hashCount: data.nonce + 1, // nonceは0から始まるため+1
          isWinner: false
        });

        // 管理者画面に個別のプレイヤー進捗を送信
        wss.clients.forEach(client => {
          if (client.role === 'admin' && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'player_progress',
              username: ws.username,
              nonce: data.nonce,
              hash: data.hash
            }));
          }
        });
      }
    } else if (data.type === 'win' && ws.role === 'player') {
      // プレイヤーがハッシュを見つけた
      // 現在マイニング中で、まだ勝者が見つかっていない場合のみ登録
      if (gameState.status === 'mining' && !gameState.winner) {
        gameState.winner = { username: ws.username, time: data.time };
        gameState.status = 'finished'; // ゲームは終了状態へ

        // currentMiningParticipants に勝者情報を追加/更新
        gameState.currentMiningParticipants.set(ws.username, {
          username: ws.username,
          time: data.time,
          hashCount: data.hashCount,
          isWinner: true
        });

        db.run(
          // ★ここを変更：hashCount も保存
          `INSERT INTO historical_winners (username, time, hash_count) VALUES (?, ?, ?)`,
          [ws.username, data.time, data.hashCount],
          err => {
            if (err) {
              console.error('歴代勝者DB保存エラー:', err);
              return;
            }
            console.log(`歴代勝者記録: ${ws.username} (${data.time}秒, ${data.hashCount}回)`);

            // 勝者確定後、すべてのクライアントに歴代ランキングを更新して送信
            broadcastHistoricalRanking();
          }
        );

        broadcast(JSON.stringify({
          type: 'winner',
          winner: { username: gameState.winner.username, time: gameState.winner.time },
          allParticipants: Array.from(gameState.currentMiningParticipants.values())
        }));
        broadcast(JSON.stringify({ type: 'state', state: gameState.status })); // ゲーム状態を'finished'に更新
        console.log(`ゲーム終了。勝者: ${ws.username}`);
        sendAdminState(); // 管理者画面の状態を更新
      } else {
        console.log(`${ws.username} からの無効な勝利メッセージ。現在のゲーム状態: ${gameState.status}, 勝者: ${gameState.winner ? gameState.winner.username : 'なし'}`);
      }
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`${ws.username || '未登録ユーザー'} が切断されました。コード: ${code}, 理由: ${reason}`);
    if (ws.username && gameState.players.has(ws.username)) {
      const player = gameState.players.get(ws.username);
      if (player) {
        player.connected = false; // 切断状態をマーク
      }
      sendAdminState(); // 管理者画面に接続状況の更新を通知
    }
  });

  ws.on('error', error => {
    console.error('WebSocketエラー:', error);
  });
});

console.log('サーバー起動: ws://192.0.0.2:8080'); // IPアドレスも出力に含める
broadcastHistoricalRanking(); // サーバー起動時に一度ランキングを送信