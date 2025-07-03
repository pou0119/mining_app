let ws;
let nonce = 0;
let baseData = '';
let startTime = null;
let gameActive = false;
let currentPlayersProgress = new Map();

// config.jsから読み込んだ設定を使う
const WS_URL = `ws://${SERVER_CONFIG.IP}:${SERVER_CONFIG.PORT}`;

// Enterキーの長押し防止用フラグ
let isEnterKeyDown = false;
// リロード対策用の変数
let hashesComputedSinceLastReport = 0;
const REPORT_INTERVAL_HASHES = 20;
let lastComputedHash = '';

const usernameInput = document.getElementById('username');
const connectButton = document.getElementById('connectBtn');
const mineButton = document.getElementById('mineBtn');
const hashOutput = document.getElementById('hashOutput');
const winnerOutput = document.getElementById('winnerOutput');
const statusMessage = document.getElementById('statusMessage');
const rankingBody = document.getElementById('rankingBody');

const gameScreen = document.getElementById('gameScreen');
const endScreen = document.getElementById('endScreen');
const finalWinnerOutput = document.getElementById('finalWinnerOutput');
const endRankingBody = document.getElementById('endRankingBody');

function showScreen(screenId) {
    gameScreen.style.display = 'none';
    endScreen.style.display = 'none';
    document.getElementById(screenId).style.display = 'block';
}

function connectToGame() {
    const name = usernameInput.value.trim();
    if (!name) {
        alert('ユーザーネームを入力してください');
        return;
    }
    document.getElementById('crack-container').innerHTML = '';

    if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
    }

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'register', username: name }));
        statusMessage.textContent = `${name} でエントリー中。サーバーからゲーム状態を待機中...`;
        mineButton.disabled = true;
        winnerOutput.textContent = '';
        hashOutput.textContent = 'ここにハッシュが表示されます';
        currentPlayersProgress.clear();
        showScreen('gameScreen');
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        const currentUsername = usernameInput.value.trim();
        const crackContainer = document.getElementById('crack-container'); // ひび割れコンテナを取得

        if (msg.type === 'state') {
            if (msg.state === 'mining') {
                statusMessage.textContent = `${currentUsername} でエントリー中。マイニング中...`;
                gameActive = true;
                mineButton.disabled = false;
                if (!startTime) {
                    startTime = Date.now();
                }
                winnerOutput.textContent = '';
                currentPlayersProgress.clear();
                showScreen('gameScreen');
            } else if (msg.state === 'idle') {
                statusMessage.textContent = `${currentUsername} でエントリー中。ゲーム開始を待機中...`;
                gameActive = false;
                mineButton.disabled = true;
                nonce = 0;
                baseData = '';
                startTime = null;
                hashesComputedSinceLastReport = 0;
                showScreen('gameScreen');
            } else if (msg.state === 'finished') {
                statusMessage.textContent = `${currentUsername} でエントリー中。ゲーム終了。`;
                gameActive = false;
                mineButton.disabled = true;
                nonce = 0;
                baseData = '';
                startTime = null;
                hashesComputedSinceLastReport = 0;
            }
        } else if (msg.type === 'countdown') {
            statusMessage.textContent = `${currentUsername} でエントリー中。ゲーム開始まで: ${msg.secondsLeft} 秒`;
            mineButton.disabled = true;
            nonce = 0;
            baseData = '';
            startTime = null;
            hashesComputedSinceLastReport = 0;
        } else if (msg.type === 'winner') {
            finalWinnerOutput.textContent = `🎉 勝者は ${msg.winner.username} (${msg.winner.time}秒) 🎉`;
            gameActive = false;
            mineButton.disabled = true;
            showScreen('endScreen');
            updateEndRanking(msg.allParticipants);
            hashesComputedSinceLastReport = 0;
            crackContainer.innerHTML = ''; // ★変更点：勝者が決まったらひび割れを消去
        } else if (msg.type === 'ranking') {
            updateOverallRanking(msg.data);
        } else if (msg.type === 'game_reset') {
            statusMessage.textContent = `ユーザーネームを入力してエントリーしよう！`;
            mineButton.disabled = true;
            winnerOutput.textContent = '';
            hashOutput.textContent = 'ここにハッシュが表示されます';
            nonce = 0;
            baseData = '';
            startTime = null;
            gameActive = false;
            currentPlayersProgress.clear();
            showScreen('gameScreen');
            updateEndRanking();
            hashesComputedSinceLastReport = 0;
            crackContainer.innerHTML = ''; // ★変更点：ゲームリセット時にひび割れを消去
        } else if (msg.type === 'game_start_info') {
            nonce = msg.nonce;
            baseData = msg.baseData;
            hashOutput.textContent = `初期nonce: ${nonce}, baseData: ${baseData.substring(0, 10)}...`;
        } else if (msg.type === 'player_progress_update') {
            currentPlayersProgress.set(msg.username, {
                hashCount: msg.nonce
            });
        }
    };

    ws.onclose = () => {
        console.log('サーバーとの接続が切れました');
        statusMessage.textContent = `サーバー切断。ユーザーネームを入力して再接続してください。`;
        mineButton.disabled = true;
        gameActive = false;
        nonce = 0;
        baseData = '';
        startTime = null;
        winnerOutput.textContent = '';
        hashOutput.textContent = 'ここにハッシュが表示されます';
        currentPlayersProgress.clear();
        hashesComputedSinceLastReport = 0;
    };

    ws.onerror = (err) => {
        console.error('WebSocketエラー:', err);
        statusMessage.textContent = `接続エラー。サーバーに接続できません。`;
        mineButton.disabled = true;
        gameActive = false;
        nonce = 0;
        baseData = '';
        startTime = null;
        winnerOutput.textContent = '';
        hashOutput.textContent = 'ここにハッシュが表示されます';
        currentPlayersProgress.clear();
        hashesComputedSinceLastReport = 0;
    };
}

window.onload = () => {
    connectToGame();
};

connectButton.onclick = () => {
    connectToGame();
};

mineButton.onclick = async () => {
    await mine();
};

async function mine() {
    if (!gameActive || mineButton.disabled) {
        return;
    }

    const crackContainer = document.getElementById('crack-container');

    // 現在のひび割れの数が20個以上なら、一番古いものを削除
    if (crackContainer.children.length >= 20) {
        crackContainer.removeChild(crackContainer.firstChild);
    }

    // --- ここから下はひび割れを生成する元のコードと同じ ---

    const crack = document.createElement('img');

    crack.src = 'images/crack.png'; // 画像のパス
    crack.className = 'crack-image'; // CSSクラスを適用

    // ランダムな位置、サイズ、角度を設定してリアル感を出す
    const size = 150 + Math.random() * 100; // 150pxから250pxのランダムなサイズ
    crack.style.width = `${size}px`;
    crack.style.height = 'auto';

    // 画面の少し内側にランダムに配置
    crack.style.top = `${Math.random() * 80}%`;
    crack.style.left = `${Math.random() * 80}%`;

    // ランダムな角度
    crack.style.transform = `rotate(${Math.random() * 360}deg)`;

    // コンテナにひび割れ画像を追加
    crackContainer.appendChild(crack);

    const dataToHash = baseData + nonce;
    const hash = await sha256(dataToHash);
    lastComputedHash = hash; // 計算したハッシュを毎回保持する

    hashOutput.textContent = `nonce: ${nonce}, hash: ${hash.substring(0, 20)}...`;

    hashesComputedSinceLastReport++;

    // 20回ごとにサーバーに進捗を報告
    if (hashesComputedSinceLastReport >= REPORT_INTERVAL_HASHES) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'player_progress',
                nonce: nonce + 1, // 次に計算するnonce
                hash: hash
            }));
            hashesComputedSinceLastReport = 0; // カウンターをリセット
        }
    }

    if (hash.startsWith('00')) {
        const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
        ws.send(JSON.stringify({ type: 'win', time: timeTaken, hashCount: nonce + 1 }));
        mineButton.disabled = true;
        gameActive = false;
    }

    nonce++;
}

// Enterキーの長押し防止
document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !usernameInput.matches(':focus') && gameActive && !mineButton.disabled) {
        event.preventDefault();

        if (isEnterKeyDown) {
            return;
        }

        isEnterKeyDown = true;
        mine();
    }
});

document.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') {
        isEnterKeyDown = false;
    }
});

// ページ離脱時に進捗を報告するイベントリスナー
window.addEventListener('beforeunload', () => {
    // ゲーム中で、かつ未報告の計算がある場合
    if (gameActive && hashesComputedSinceLastReport > 0) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            // send()は非同期だが、ページが閉じる前に送信を試みる
            ws.send(JSON.stringify({
                type: 'player_progress',
                nonce: nonce, // 次に計算するべきnonceの値(インクリメント済)を送信
                hash: lastComputedHash
            }));
        }
    }
});

function updateOverallRanking(data) {
    rankingBody.innerHTML = '';

    if (!data || data.length === 0) {
        rankingBody.innerHTML = '<tr><td colspan="4">歴代データがありません</td></tr>';
        return;
    }

    data.forEach((row, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${i + 1}</td><td>${row.username}</td><td>${row.time}</td><td>${row.hash_count ?? '-'}</td>`;
        rankingBody.appendChild(tr);
    });
}

function updateEndRanking(participantsData = null) {
    endRankingBody.innerHTML = '';

    if (!participantsData || participantsData.length === 0) {
        endRankingBody.innerHTML = '<tr><td colspan="4">今回の参加者データがありません</td></tr>';
        return;
    }

    participantsData.sort((a, b) => {
        if (a.time !== null && b.time === null) return -1;
        if (a.time === null && b.time !== null) return 1;
        if (a.time !== null && b.time !== null) {
            return a.time - b.time;
        }
        return b.hashCount - a.hashCount;
    });

    participantsData.forEach((row, i) => {
        const tr = document.createElement('tr');
        const rank = i + 1;
        const timeDisplay = row.time !== null ? row.time : '-';
        const hashCountDisplay = row.hashCount !== null ? row.hashCount : '-';

        tr.innerHTML = `
            <td>${rank}</td>
            <td>${row.username}</td>
            <td>${timeDisplay}</td>
            <td>${hashCountDisplay}</td>
        `;
        endRankingBody.appendChild(tr);

        if (row.isWinner) {
            tr.style.fontWeight = 'bold';
            tr.style.backgroundColor = '#e6ffe6';
        }
    });
}

// SHA256ハッシュ関数
function sha256(str) {
    const buf = new TextEncoder('utf-8').encode(str);
    return crypto.subtle.digest('SHA-256', buf).then(hashBuffer => {
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    });
}