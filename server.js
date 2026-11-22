const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000
});

// Раздача статических файлов (включая plus2.mp3, plus4.mp3, uno.mp3, wild.mp3)
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const colors = ['red', 'blue', 'green', 'yellow'];
let deck = [];
let players = [];
let currentCard = null;
let turnIndex = 0;
let direction = 1;
let gameStarted = false;
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
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function drawFromDeck(count) {
    let drawn = [];
    for (let i = 0; i < count; i++) {
        if (deck.length === 0) createDeck();
        drawn.push(deck.pop());
    }
    return drawn;
}

function getNextIndex(steps = 1) {
    const len = players.length;
    if (len === 0) return 0;
    return (turnIndex + steps * direction + len * 100) % len;
}

function broadcastState() {
    players.forEach((player, index) => {
        if (!player.socketId) return;
        const playersList = players.map((p, idx) => ({
            id: p.id,
            name: p.name,
            count: p.hand.length,
            score: p.score,
            saidUno: p.saidUno,
            isTurn: gameStarted && idx === turnIndex,
            isMe: idx === index,
            disconnected: !p.socketId
        }));

        io.to(player.socketId).emit('gameState', {
            gameStarted,
            hand: player.hand,
            playersList,
            saidUno: player.saidUno,
            currentCard,
            direction,
            targetScore: TARGET_SCORE,
            isMyTurn: gameStarted && index === turnIndex
        });
    });
}

function startNewRound() {
    gameStarted = true;
    direction = 1;
    turnIndex = 0;
    createDeck();

    players.forEach(p => {
        p.hand = drawFromDeck(7);
        p.saidUno = false;
    });

    do {
        currentCard = deck.pop();
    } while (currentCard.color === 'black');

    broadcastState();
}

io.on('connection', (socket) => {
    socket.on('joinGame', ({ playerId, playerName }) => {
        if (!playerId) return;

        // Проверка переподключения существующего игрока
        const existing = players.find(p => p.id === playerId);
        if (existing) {
            if (existing.disconnectTimer) {
                clearTimeout(existing.disconnectTimer);
                existing.disconnectTimer = null;
            }
            existing.socketId = socket.id;
            if (playerName && playerName.trim()) {
                existing.name = playerName.trim().slice(0, 15);
            }
            broadcastState();
            return;
        }

        if (gameStarted || players.length >= 8) {
            socket.emit('errorMsg', 'Игра уже идет или стол заполнен (максимум 8 игроков).');
            return;
        }

        const cleanName = (playerName || '').trim().slice(0, 15) || `Игрок ${players.length + 1}`;
        players.push({
            id: playerId,
            socketId: socket.id,
            name: cleanName,
            hand: [],
            score: 0,
            saidUno: false,
            disconnectTimer: null
        });
        broadcastState();
    });

    socket.on('startGame', () => {
        if (gameStarted || players.length < 2) return;
        players.forEach(p => p.score = 0);
        startNewRound();
        io.emit('playSound', 'start');
    });

    socket.on('sayUno', () => {
        const p = players.find(p => p.socketId === socket.id);
        if (p && p.hand.length <= 2 && !p.saidUno) {
            p.saidUno = true;
            io.emit('chatMessage', { sender: 'Система', text: `🔥 ${p.name} кричит УНО!`, isSystem: true });
            io.emit('playSound', 'uno');
            broadcastState();
        }
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        if (!gameStarted) return;
        const pIndex = players.findIndex(p => p.socketId === socket.id);
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

        // Проверка окончания раунда и забытого УНО
        if (player.hand.length === 0) {
            if (!player.saidUno) {
                player.hand.push(...drawFromDeck(2));
                io.to(player.socketId).emit('alertMsg', 'Вы забыли нажать УНО! Штраф +2 карты.');
                io.emit('playSound', 'plus2');
            } else {
                // Подсчет очков за карты на руках у соперников
                let roundPoints = 0;
                players.forEach((other, idx) => {
                    if (idx !== pIndex) {
                        other.hand.forEach(c => roundPoints += (c.points || 0));
                    }
                });
                player.score += roundPoints;

                const scoreboard = players
                    .map(p => ({ name: p.name, score: p.score }))
                    .sort((a, b) => b.score - a.score);

                if (player.score >= TARGET_SCORE) {
                    io.emit('matchOver', {
                        winner: player.name,
                        roundPoints,
                        scoreboard
                    });
                    resetFullMatch();
                } else {
                    io.emit('roundOver', {
                        winner: player.name,
                        roundPoints,
                        scoreboard
                    });
                    setTimeout(() => {
                        if (players.length >= 2) startNewRound();
                    }, 4500);
                }
                return;
            }
        }

        if (player.hand.length > 1) player.saidUno = false;

        // Обработка спецкарт и звуков
        if (card.type === 'reverse') {
            io.emit('playSound', 'card');
            if (players.length === 2) {
                turnIndex = getNextIndex(2);
            } else {
                direction *= -1;
                turnIndex = getNextIndex(1);
            }
        } else if (card.type === 'skip') {
            io.emit('playSound', 'card');
            turnIndex = getNextIndex(2);
        } else if (card.type === 'draw2') {
            const victimIndex = getNextIndex(1);
            const victim = players[victimIndex];
            victim.hand.push(...drawFromDeck(2));
            victim.saidUno = false;

            io.emit('playSound', 'plus2');
            // Автоматический стикер жертве
            if (victim.socketId) {
                io.to(victim.socketId).emit('tauntSticker', {
                    sender: player.name,
                    emoji: '😈',
                    text: 'Лови +2!',
                    isPrivate: true
                });
            }
            io.to(player.socketId).emit('chatMessage', {
                sender: 'Система',
                text: `Вы подкинули +2 игроку ${victim.name}`,
                isSystem: true
            });

            turnIndex = getNextIndex(2);
        } else if (card.type === 'wild4') {
            const victimIndex = getNextIndex(1);
            const victim = players[victimIndex];
            victim.hand.push(...drawFromDeck(4));
            victim.saidUno = false;

            io.emit('playSound', 'plus4');
            // Автоматический стикер жертве
            if (victim.socketId) {
                io.to(victim.socketId).emit('tauntSticker', {
                    sender: player.name,
                    emoji: '💀',
                    text: 'Лови +4!',
                    isPrivate: true
                });
            }
            io.to(player.socketId).emit('chatMessage', {
                sender: 'Система',
                text: `Вы подкинули +4 игроку ${victim.name}`,
                isSystem: true
            });

            turnIndex = getNextIndex(2);
        } else if (card.type === 'wild') {
            io.emit('playSound', 'wild');
            turnIndex = getNextIndex(1);
        } else {
            io.emit('playSound', 'card');
            turnIndex = getNextIndex(1);
        }

        broadcastState();
    });

    socket.on('drawCard', () => {
        if (!gameStarted) return;
        const pIndex = players.findIndex(p => p.socketId === socket.id);
        if (pIndex !== turnIndex) return;

        players[pIndex].hand.push(...drawFromDeck(1));
        players[pIndex].saidUno = false;
        io.emit('playSound', 'card');
        turnIndex = getNextIndex(1);
        broadcastState();
    });

    socket.on('sendChat', (text) => {
        const p = players.find(p => p.socketId === socket.id);
        if (!p || !text) return;
        const cleanText = String(text).trim().slice(0, 80);
        if (cleanText) {
            io.emit('chatMessage', { sender: p.name, text: cleanText, isSystem: false });
        }
    });

    socket.on('sendTaunt', ({ targetId, emoji, text }) => {
        const sender = players.find(p => p.socketId === socket.id);
        if (!sender) return;

        if (!targetId || targetId === 'all') {
            io.emit('tauntSticker', {
                sender: sender.name,
                emoji,
                text,
                isPrivate: false
            });
        } else {
            const target = players.find(p => p.id === targetId);
            if (target && target.socketId) {
                io.to(target.socketId).emit('tauntSticker', {
                    sender: sender.name,
                    emoji,
                    text,
                    isPrivate: true
                });
                io.to(sender.socketId).emit('chatMessage', {
                    sender: 'Система',
                    text: `Стикер ${emoji} "${text}" отправлен лично для ${target.name}`,
                    isSystem: true
                });
            }
        }
    });

    socket.on('disconnect', () => {
        const pIndex = players.findIndex(p => p.socketId === socket.id);
        if (pIndex === -1) return;

        const player = players[pIndex];
        player.socketId = null;
        broadcastState();

        // Ждем 45 секунд перед полным удалением игрока
        player.disconnectTimer = setTimeout(() => {
            const currentIdx = players.findIndex(p => p.id === player.id);
            if (currentIdx !== -1 && !players[currentIdx].socketId) {
                const leftName = players[currentIdx].name;
                players.splice(currentIdx, 1);

                if (gameStarted) {
                    if (players.length < 2) {
                        io.emit('errorMsg', `Игрок ${leftName} не вернулся. Недостаточно игроков для продолжения.`);
                        resetFullMatch();
                    } else {
                        if (turnIndex >= players.length) turnIndex = 0;
                        io.emit('chatMessage', { sender: 'Система', text: `⚠️ ${leftName} покинул стол.`, isSystem: true });
                        broadcastState();
                    }
                } else {
                    broadcastState();
                }
            }
        }, 45000);
    });
});

function resetFullMatch() {
    players.forEach(p => {
        if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    });
    players = [];
    gameStarted = false;
    currentCard = null;
    turnIndex = 0;
    direction = 1;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер UNO запущен на порту ${PORT}`));
