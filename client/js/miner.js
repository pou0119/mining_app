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
// スクランブル表示用の変数
let scrambleInterval = null;
// 演出中の多重入力を防ぐためのフラグ
let isAnimating = false;

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

// 待機時間を作るためのヘルパー関数
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

    if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
    }
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'register', username: name }));
        statusMessage.textContent = `${name} でエントリー中。サーバーからゲーム状態を待機中...`;
        mineButton.disabled = true;
        winnerOutput.textContent = '';
        hashOutput.textContent = 'Awaiting analysis target...';
        currentPlayersProgress.clear();
        showScreen('gameScreen');
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        const currentUsername = usernameInput.value.trim();

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
                startScramblingEffect();
            } else {
                gameActive = false;
                mineButton.disabled = true;
                stopScramblingEffect();
                if (msg.state === 'idle') {
                    statusMessage.textContent = `${currentUsername} でエントリー中。ゲーム開始を待機中...`;
                    nonce = 0;
                    baseData = '';
                    startTime = null;
                    hashesComputedSinceLastReport = 0;
                    showScreen('gameScreen');
                    hashOutput.textContent = 'Awaiting analysis target...';
                } else if (msg.state === 'finished') {
                    statusMessage.textContent = `${currentUsername} でエントリー中。ゲーム終了。`;
                    nonce = 0;
                    baseData = '';
                    startTime = null;
                    hashesComputedSinceLastReport = 0;
                }
            }
        } else if (msg.type === 'countdown') {
            statusMessage.textContent = `${currentUsername} でエントリー中。ゲーム開始まで: ${msg.secondsLeft} 秒`;
            mineButton.disabled = true;
            nonce = 0;
            baseData = '';
            startTime = null;
            hashesComputedSinceLastReport = 0;
            stopScramblingEffect();
            hashOutput.textContent = `SYSTEM LOCK IN ${msg.secondsLeft} SECONDS...`;
        } else if (msg.type === 'winner') {
            finalWinnerOutput.textContent = `🎉 勝者は ${msg.winner.username} (${msg.winner.time}秒) 🎉`;
            gameActive = false;
            mineButton.disabled = true;
            showScreen('endScreen');
            updateEndRanking(msg.allParticipants);
            hashesComputedSinceLastReport = 0;
            stopScramblingEffect();
        } else if (msg.type === 'ranking') {
            updateOverallRanking(msg.data);
        } else if (msg.type === 'game_reset') {
            statusMessage.textContent = `ユーザーネームを入力してエントリーしよう！`;
            mineButton.disabled = true;
            winnerOutput.textContent = '';
            hashOutput.textContent = 'Awaiting analysis target...';
            nonce = 0;
            baseData = '';
            startTime = null;
            gameActive = false;
            currentPlayersProgress.clear();
            showScreen('gameScreen');
            updateEndRanking();
            hashesComputedSinceLastReport = 0;
            stopScramblingEffect();
        } else if (msg.type === 'game_start_info' && !gameActive) {
            nonce = msg.nonce;
            baseData = msg.baseData;
        } else if (msg.type === 'player_progress_update') {
            currentPlayersProgress.set(msg.username, {
                hashCount: msg.nonce
            });
        }
    };

    ws.onclose = () => {
        stopScramblingEffect();
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
        stopScramblingEffect();
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
    if (!gameActive || mineButton.disabled || isAnimating) {
        return;
    }

    mineButton.disabled = true;
    stopScramblingEffect();

    const dataToHash = baseData + nonce;
    const hash = await sha256(dataToHash);
    lastComputedHash = hash;

    if (hash.startsWith('0')) {
        gameActive = false;
        isAnimating = true;
        
        await revealHash(hash);
        
        // ★ 勝利演出後、2秒待機
        await sleep(2000);
        
        const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
        ws.send(JSON.stringify({ type: 'win', time: timeTaken, hashCount: nonce + 1 }));
        
        isAnimating = false;
    } else {
        hashOutput.textContent = hash.substring(0, 20) + '...';
        document.body.classList.add('flash-red');

        setTimeout(() => {
            document.body.classList.remove('flash-red');
            mineButton.disabled = false;
            if (gameActive) {
                startScramblingEffect();
            }
        }, 300);
    }

    hashesComputedSinceLastReport++;
    if (hashesComputedSinceLastReport >= REPORT_INTERVAL_HASHES) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'player_progress',
                nonce: nonce + 1,
                hash: hash
            }));
            hashesComputedSinceLastReport = 0;
        }
    }
    nonce++;
}

async function revealHash(hash) {
    const displayHash = hash.substring(0, 20);
    const sound = document.getElementById('char-reveal-sound');
    let revealedString = '_'.repeat(displayHash.length);

    hashOutput.classList.remove('scrambling');

    for (let i = displayHash.length - 1; i >= 0; i--) {
        const leftPart = '_'.repeat(i);
        const rightPart = displayHash.substring(i);
        revealedString = leftPart + rightPart;

        let html = '';
        for (const char of revealedString) {
            if (char === '_') {
                html += `<span class="hidden-char">?</span>`;
            } else {
                html += `<span class="revealed-char">${char}</span>`;
            }
        }
        hashOutput.innerHTML = html;

        if (sound) {
            sound.currentTime = 0;
            sound.play().catch(e => console.error("Sound play failed:", e));
        }

        const delay = 30 + (10 * (displayHash.length - i));
        await sleep(delay);
    }
    hashOutput.innerHTML += '<span class="hidden-char">...</span>';
}

// ★ ハッシュのスクランブル表示用関数を修正
function startScramblingEffect() {
    if (scrambleInterval) return;
    const chars = '0123456789abcdefABCDEF!?#$';
    hashOutput.classList.add('scrambling');

    scrambleInterval = setInterval(() => {
        // ★ '??'を先頭に表示するように変更
        let scrambledText = '??'; 
        for (let i = 0; i < 18; i++) {
            scrambledText += chars[Math.floor(Math.random() * chars.length)];
        }
        hashOutput.textContent = scrambledText + '...';
    }, 50);
}

function stopScramblingEffect() {
    clearInterval(scrambleInterval);
    scrambleInterval = null;
    hashOutput.classList.remove('scrambling');
    hashOutput.textContent = '... ANALYSIS PAUSED ...';
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !usernameInput.matches(':focus') && gameActive && !mineButton.disabled && !isAnimating) {
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

window.addEventListener('beforeunload', () => {
    if (gameActive && hashesComputedSinceLastReport > 0) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'player_progress',
                nonce: nonce,
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
            tr.style.backgroundColor = 'rgba(3, 218, 198, 0.2)';
        }
    });
}

function sha256(str) {
    const buf = new TextEncoder('utf-8').encode(str);
    return crypto.subtle.digest('SHA-256', buf).then(hashBuffer => {
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    });
}