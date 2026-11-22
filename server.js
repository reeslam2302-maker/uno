const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const colors = ['red', 'blue', 'green', 'yellow'];
let deck = [];
let discardPile = [];
let players = [];
let currentCard = null;
let turnIndex = 0;
let direction = 1;
let gameStarted = false;
let roundNumber = 1;
const TARGET_SCORE = 250;

function createDeck() {
    deck = [];
    for (let color of colors) {
        deck.push({ color, value: '0', type: 'number', points: 0 });
        for (let num = 1; num <= 9; num++) {
            deck.push({ color, value: String(num), type: 'number', points: num });
            deck.push({ color, value: String(num), type: 'number', points: num });
        }
        for (let i = 0; i < 2; i++) {
            deck.push({ color, value: '+2', type: 'draw2', points: 20 });
            deck.push({ color, value: '🚫', type: 'skip', points: 20 });
            deck.push({ color, value: '🔄', type: 'reverse', points: 20 });
        }
    }
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: '🌈', type: 'wild', points: 50 });
        deck.push({ color: 'black', value: '+4', type: 'wild4', points: 50 });
    }
    shuffle(deck);
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function drawFromDeck(count) {
    let drawn = [];
    for (let i = 0; i < count; i++) {
        if (deck.length === 0) {
            if (discardPile.length > 1) {
                const top = discardPile.pop();
                deck = discardPile.map(c => ({
                    ...c,
                    color: (c.type === 'wild' || c.type === 'wild4') ? 'black' : c.color
                }));
                discardPile = [top];
                shuffle(deck);
            } else {
                createDeck();
            }
        }
        if (deck.length > 0) drawn.push(deck.pop());
    }
    return drawn;
}

function getNextIndex(steps = 1) {
    const len = players.length;
    if (len === 0) return 0;
    return (turnIndex + steps * direction + len * 20) % len;
}

function broadcastState(soundEvent = null) {
    players.forEach((player, index) => {
        if (!player.connected) return;
        const otherPlayers = players.map((p, idx) => ({
            name: p.name,
            count: p.hand.length,
            score: p.score,
            saidUno: p.saidUno,
            isTurn: gameStarted && idx === turnIndex,
            isMe: idx === index,
            connected: p.connected
        }));

        io.to(player.id).emit('gameState', {
            gameStarted,
            roundNumber,
            targetScore: TARGET_SCORE,
            hand: player.hand,
            playersList: otherPlayers,
            saidUno: player.saidUno,
            currentCard,
            direction,
            isMyTurn: gameStarted && index === turnIndex,
            soundEvent
        });
    });
}

function startNewRound() {
    gameStarted = true;
    direction = 1;
    turnIndex = (roundNumber - 1) % players.length;
    createDeck();
    discardPile = [];

    players.forEach(p => {
        p.hand = drawFromDeck(7);
        p.saidUno = false;
    });

    do {
        currentCard = deck.pop();
    } while (currentCard.color === 'black');
    discardPile.push(currentCard);

    broadcastState('start');
}

io.on('connection', (socket) => {
    socket.on('joinGame', ({ name, playerId }) => {
        const cleanName = (name || '').trim().slice(0, 14) || `Игрок ${players.length + 1}`;
        
        // Проверяем, не переподключается ли это вылетевший игрок
        let existing = players.find(p => p.playerId === playerId);
        if (existing) {
            if (existing.disconnectTimer) {
                clearTimeout(existing.disconnectTimer);
                existing.disconnectTimer = null;
            }
            existing.id = socket.id;
            existing.connected = true;
            if (name && name.trim()) existing.name = cleanName;
            
            io.emit('chatMessage', { sender: 'Система', text: `✅ ${existing.name} вернулся в игру!`, isSystem: true });
            broadcastState();
            return;
        }

        if (gameStarted) {
            socket.emit('errorMsg', 'Матч уже идет. Дождитесь окончания или попросите хоста перезапустить.');
            return;
        }
        if (players.length >= 8) {
            socket.emit('errorMsg', 'За столом уже максимум (8 игроков).');
            return;
        }

        players.push({
            id: socket.id,
            playerId: playerId || socket.id,
            name: cleanName,
            hand: [],
            score: 0,
            saidUno: false,
            connected: true,
            disconnectTimer: null
        });
        broadcastState();
    });

    socket.on('startGame', () => {
        if (gameStarted || players.length < 2) return;
        roundNumber = 1;
        players.forEach(p => p.score = 0);
        startNewRound();
    });

    socket.on('sayUno', () => {
        const p = players.find(p => p.id === socket.id);
        if (p && p.hand.length <= 2 && !p.saidUno) {
            p.saidUno = true;
            io.emit('chatMessage', { sender: 'Система', text: `🔥 ${p.name} кричит УНО!`, isSystem: true });
            broadcastState('uno');
        }
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        if (!gameStarted) return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex !== turnIndex) return;

        const player = players[pIndex];
        const card = player.hand[cardIndex];
        if (!card) return;

        const isValid = card.color === 'black' ||
                        card.color === currentCard.color ||
                        card.value === currentCard.value;

        if (!isValid) return;

        player.hand.splice(cardIndex, 1);
        currentCard = { ...card };

        if (card.color === 'black' && colors.includes(chosenColor)) {
            currentCard.color = chosenColor;
        }
        discardPile.push(currentCard);

        // Проверка конца раунда
        if (player.hand.length === 0) {
            if (!player.saidUno) {
                player.hand.push(...drawFromDeck(2));
                io.to(player.id).emit('alertMsg', 'Забыли нажать УНО! Штраф +2 карты.');
                broadcastState('penalty');
                return;
            } else {
                let roundPoints = 0;
                players.forEach((p, idx) => {
                    if (idx !== pIndex) {
                        roundPoints += p.hand.reduce((sum, c) => sum + c.points, 0);
                    }
                });
                player.score += roundPoints;

                const standings = [...players]
                    .sort((a, b) => b.score - a.score)
                    .map(p => ({ name: p.name, score: p.score }));

                if (player.score >= TARGET_SCORE) {
                    io.emit('matchOver', {
                        winner: player.name,
                        roundPoints,
                        standings
                    });
                    resetGame();
                } else {
                    gameStarted = false;
                    io.emit('roundOver', {
                        winner: player.name,
                        roundPoints,
                        standings,
                        nextRound: roundNumber + 1
                    });
                    setTimeout(() => {
                        if (players.length >= 2 && !gameStarted) {
                            roundNumber++;
                            startNewRound();
                        }
                    }, 6000);
                }
                return;
            }
        }

        if (player.hand.length > 1) player.saidUno = false;

        let sound = 'card';
        if (card.type === 'reverse') {
            if (players.length === 2) {
                turnIndex = getNextIndex(2);
            } else {
                direction *= -1;
                turnIndex = getNextIndex(1);
            }
        } else if (card.type === 'skip') {
            turnIndex = getNextIndex(2);
        } else if (card.type === 'draw2') {
            const victim = players[getNextIndex(1)];
            victim.hand.push(...drawFromDeck(2));
            victim.saidUno = false;
            io.to(victim.id).emit('playSound', 'penalty');
            turnIndex = getNextIndex(2);
        } else if (card.type === 'wild4') {
            const victim = players[getNextIndex(1)];
            victim.hand.push(...drawFromDeck(4));
            victim.saidUno = false;
            io.to(victim.id).emit('playSound', 'penalty');
            turnIndex = getNextIndex(2);
        } else {
            turnIndex = getNextIndex(1);
        }

        broadcastState(sound);
    });

    socket.on('drawCard', () => {
        if (!gameStarted) return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex !== turnIndex) return;

        players[pIndex].hand.push(...drawFromDeck(1));
        players[pIndex].saidUno = false;
        turnIndex = getNextIndex(1);
        broadcastState('card');
    });

    socket.on('sendChat', (text) => {
        const p = players.find(p => p.id === socket.id);
        if (!p || !text) return;
        const cleanText = String(text).trim().slice(0, 80);
        if (cleanText) {
            io.emit('chatMessage', { sender: p.name, text: cleanText, isSystem: false });
        }
    });

    socket.on('sendSticker', (sticker) => {
        const p = players.find(p => p.id === socket.id);
        if (!p || !sticker) return;
        io.emit('showSticker', { sender: p.name, sticker });
    });

    socket.on('disconnect', () => {
        const p = players.find(p => p.id === socket.id);
        if (!p) return;

        p.connected = false;
        broadcastState();

        if (!gameStarted) {
            // В лобби ждем 10 секунд перед удалением
            p.disconnectTimer = setTimeout(() => {
                const idx = players.indexOf(p);
                if (idx !== -1 && !players[idx].connected) {
                    players.splice(idx, 1);
                    broadcastState();
                }
            }, 10000);
        } else {
            // В активной игре даем 45 секунд на автопереподключение (например, если свернул браузер на телефоне)
            io.emit('chatMessage', { sender: 'Система', text: `⚠️ У ${p.name} пропала связь. Ждем возвращения (45 сек)...`, isSystem: true });
            p.disconnectTimer = setTimeout(() => {
                if (!p.connected && gameStarted) {
                    io.emit('chatMessage', { sender: 'Система', text: `❌ ${p.name} не вернулся и исключен из матча.`, isSystem: true });
                    const idx = players.indexOf(p);
                    if (idx !== -1) {
                        const wasHisTurn = (idx === turnIndex);
                        players.splice(idx, 1);
                        if (players.length < 2) {
                            io.emit('errorMsg', 'Осталось меньше 2 игроков. Матч завершен.');
                            resetGame();
                        } else {
                            if (idx < turnIndex) turnIndex--;
                            if (turnIndex >= players.length) turnIndex = 0;
                            broadcastState();
                        }
                    }
                }
            }, 45000);
        }
    });
});

function resetGame() {
    players.forEach(p => { if (p.disconnectTimer) clearTimeout(p.disconnectTimer); });
    players = [];
    gameStarted = false;
    currentCard = null;
    roundNumber = 1;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UNO 8-Players + AutoReconnect запущен: http://localhost:${PORT}`));
