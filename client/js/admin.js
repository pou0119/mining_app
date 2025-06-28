
let ws;
// プレイヤーの状態を管理するためのMap。キーはユーザー名、値は { nonce, hash, connected }
let players = new Map();

// config.jsから読み込んだ設定を使う
const WS_URL = `ws://${SERVER_CONFIG.IP}:${SERVER_CONFIG.PORT}`;

const adminNameInput = document.getElementById('adminName');
const connectBtn = document.getElementById('connectBtn');
const startGameBtn = document.getElementById('startGameBtn');
const resetGameBtn = document.getElementById('resetGameBtn');
const statusMessage = document.getElementById('statusMessage');
const playersTableBody = document.getElementById('playersTableBody');

// 接続処理
connectBtn.onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }

    const name = adminNameInput.value.trim();
    if (!name) {
        alert('管理者名を入力してください');
        return;
    }

    ws = new WebSocket(WS_URL); // 定義したWS_URLを使用

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'register', username: name, role: 'admin' }));
        statusMessage.textContent = 'サーバーに接続しました。';
        // 接続成功時はボタンを有効にする
        startGameBtn.disabled = false;
        resetGameBtn.disabled = false;
        players.clear(); // 新規接続時にプレイヤーリストをリセット
        updatePlayersTable(); // テーブルをクリア
    };

    ws.onmessage = event => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'state') {
            statusMessage.textContent = `ゲーム状態: ${msg.state}`;
            // ゲーム状態に応じてボタンの有効/無効を切り替える
            // 'idle' または 'finished' の場合のみ開始ボタンを有効
            if (msg.state === 'idle' || msg.state === 'finished') {
                startGameBtn.disabled = false;
            } else { // 'countdown' や 'mining' の場合
                startGameBtn.disabled = true;
            }
        } else if (msg.type === 'countdown') {
            statusMessage.textContent = `ゲーム開始まで: ${msg.secondsLeft} 秒`;
            startGameBtn.disabled = true; // カウントダウン中は開始ボタンを無効化
        } else if (msg.type === 'player_list') {
            // サーバーから送られてくるプレイヤーリストで、現在のplayers Mapを更新
            players.clear(); // 一度クリア
            msg.players.forEach(p => {
                players.set(p.username, {
                    nonce: p.latestNonce || '-',
                    hash: p.latestHash || '-',
                    connected: p.connected // 接続状況も保持
                });
            });
            updatePlayersTable();
        } else if (msg.type === 'player_progress') {
            // 個別のプレイヤーの進捗更新
            const player = players.get(msg.username);
            if (player) { // プレイヤーが存在すれば更新
                player.nonce = msg.nonce;
                player.hash = msg.hash;
                player.connected = true; // 進捗があったということは接続中
            } else { // 新規プレイヤーの場合は追加
                players.set(msg.username, { nonce: msg.nonce, hash: msg.hash, connected: true });
            }
            updatePlayersTable();
        }
        // サーバーから player_connected/disconnected のメッセージを受け取る場合は、ここに追加
        // 現状のサーバーコードでは player_list でまとめて送られてくるため、通常は不要
        // } else if (msg.type === 'player_connected') {
        //   players.set(msg.username, { nonce: '-', hash: '-', connected: true });
        //   updatePlayersTable();
        // } else if (msg.type === 'player_disconnected') {
        //   const player = players.get(msg.username);
        //   if (player) {
        //     player.connected = false; // 接続状態をfalseに
        //   }
        //   updatePlayersTable();
        // }
    };

    ws.onclose = () => {
        statusMessage.textContent = 'サーバー切断';
        startGameBtn.disabled = true;
        resetGameBtn.disabled = true;
        // 接続が切れたら全プレイヤーを非接続状態にマーク
        players.forEach(player => player.connected = false);
        updatePlayersTable(); // テーブルを更新
    };

    ws.onerror = () => {
        statusMessage.textContent = '接続エラー';
        startGameBtn.disabled = true;
        resetGameBtn.disabled = true;
        players.forEach(player => player.connected = false); // エラー時も非接続にマーク
        updatePlayersTable();
    };
};

// ゲーム開始ボタン
startGameBtn.onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'start_game' }));
        startGameBtn.disabled = true; // コマンドを送ったらボタンを無効化
    }
};

// ゲームリセットボタン
resetGameBtn.onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        if (confirm('ゲームをリセットして全プレイヤーを切断しますか？')) { // メッセージを明確に
            ws.send(JSON.stringify({ type: 'reset_game' }));
        }
    }
};

// プレイヤーテーブルを更新する関数
function updatePlayersTable() {
    playersTableBody.innerHTML = ''; // まずテーブルをクリア

    // connectedがtrueのプレイヤーを優先的に表示し、その後falseのプレイヤーを表示
    const sortedPlayers = Array.from(players.entries()).sort(([, a], [, b]) => {
        if (a.connected && !b.connected) return -1; // aがconnectedでbがdisconnectedならaが前
        if (!a.connected && b.connected) return 1;  // aがdisconnectedでbがconnectedならbが前
        return 0; // それ以外は順序変更なし
    });

    if (sortedPlayers.length === 0) {
        playersTableBody.innerHTML = '<tr><td colspan="4">プレイヤーはいません</td></tr>';
        return;
    }

    sortedPlayers.forEach(([username, data]) => {
        const tr = document.createElement('tr');
        // 接続状況に応じて色を変更するCSSクラスを追加することもできます
        const statusClass = data.connected ? 'status-connected' : 'status-disconnected';
        const statusText = data.connected ? '接続中' : '切断';

        tr.innerHTML = `
          <td>${username}</td>
          <td>${data.nonce}</td>
          <td>${data.hash ? data.hash.substring(0, 10) + '...' : '-'}</td>
          <td class="${statusClass}">${statusText}</td>
        `;
        playersTableBody.appendChild(tr);
    });
}

// ページ読み込み時に自動接続を試みる
window.onload = () => {
    connectBtn.click();
};
