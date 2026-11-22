const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const colors = ['red', 'blue', 'green', 'yellow'];
const botNames = ['Терминатор 🤖', 'Альтрон 🤖', 'Валли 🤖', 'R2-D2 🤖', 'Бендер 🤖', 'ГЛаДОС 🤖', 'Джарвис 🤖'];

let deck = [];
let players = [];
let currentCard = null;
let turnIndex = 0;
let direction = 1;
let gameStarted = false;
let roundNumber = 1;

let roomSettings = {
    intercept: false,
    stacking: false,
    timer: false,
    catchUno: false
};

let pendingPenalty = 0;
let turnTimeLeft = 15;
let turnInterval = null;
let botTimeout = null;

function createDeck() {
    deck = [];
    for (let color of colors) {
        deck.push({ color, value: '0', type: 'number' });
        for (let num = 1; num <= 9; num++) {
            deck.push({ color, value: String(num), type: 'number' });
            deck.push({ color, value: String(num), type: 'number' });
        }
        for (let i = 0; i < 2; i++) {
            deck.push({ color, value: '+2', type: 'draw2' });
            deck.push({ color, value: '🚫', type: 'skip' });
            deck.push({ color, value: '🔄', type: 'reverse' });
        }
    }
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: '🌈', type: 'wild' });
        deck.push({ color: 'black', value: '+4', type: 'wild4' });
    }
    deck.sort(() => Math.random() - 0.5);
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

function calculateHandPoints(hand) {
    return hand.reduce((sum, card) => {
        if (card.type === 'number') return sum + parseInt(card.value, 10);
        if (card.color === 'black') return sum + 50;
        return sum + 20;
    }, 0);
}

function startTurnTimer() {
    clearInterval(turnInterval);
    if (!gameStarted || !roomSettings.timer) return;

    turnTimeLeft = 15;
    turnInterval = setInterval(() => {
        if (!gameStarted) {
            clearInterval(turnInterval);
            return;
        }
        turnTimeLeft--;
        io.emit('timerTick', turnTimeLeft);

        if (turnTimeLeft <= 0) {
            clearInterval(turnInterval);
            handleTimeoutDraw();
        }
    }, 1000);
}

function handleTimeoutDraw() {
    const currentPlayer = players[turnIndex];
    if (!currentPlayer) return;

    const drawCount = pendingPenalty > 0 ? pendingPenalty : 1;
    currentPlayer.hand.push(...drawFromDeck(drawCount));
    currentPlayer.saidUno = false;
    pendingPenalty = 0;

    io.emit('chatMessage', {
        sender: 'Система',
        text: `⏱️ Время вышло! ${currentPlayer.name} берет ${drawCount} карт(ы).`,
        isSystem: true
    });

    turnIndex = getNextIndex(1);
    broadcastState();
    scheduleBotOrAutopilot();
}

function broadcastState() {
    players.forEach((player, index) => {
        if (player.isBot || !player.socketId) return;

        const playersList = players.map((p, idx) => ({
            uid: p.uid,
            name: p.name,
            count: p.hand.length,
            score: p.score,
            saidUno: p.saidUno,
            isBot: p.isBot,
            autopilot: p.autopilot,
            isTurn: idx === turnIndex,
            isMe: idx === index,
            canBeCaught: gameStarted && roomSettings.catchUno && p.hand.length === 1 && !p.saidUno && idx !== index
        }));

        io.to(player.socketId).emit('gameState', {
            gameStarted,
            roundNumber,
            settings: roomSettings,
            pendingPenalty,
            turnTimeLeft,
            hand: player.hand,
            playersList,
            saidUno: player.saidUno,
            currentCard,
            direction,
            isMyTurn: gameStarted && index === turnIndex
        });
    });
}

function scheduleBotOrAutopilot() {
    clearTimeout(botTimeout);
    if (!gameStarted || players.length === 0) return;

    startTurnTimer();

    const current = players[turnIndex];
    if (!current) return;

    if (current.isBot || current.autopilot) {
        botTimeout = setTimeout(() => {
            if (!gameStarted || players[turnIndex]?.uid !== current.uid) return;
            executeBotMove(turnIndex);
        }, current.isBot ? 1500 : 2800);
    }
}

function executeBotMove(pIndex) {
    const bot = players[pIndex];
    if (!bot) return;

    let validIndex = -1;
    for (let i = 0; i < bot.hand.length; i++) {
        const c = bot.hand[i];
        if (pendingPenalty > 0 && roomSettings.stacking) {
            if (c.type === 'draw2' || c.type === 'wild4') {
                validIndex = i;
                break;
            }
        } else {
            if (c.color === 'black' || c.color === currentCard.color || c.value === currentCard.value) {
                validIndex = i;
                break;
            }
        }
    }

    if (validIndex !== -1) {
        if (bot.hand.length === 2) {
            bot.saidUno = true;
            io.emit('playSound', 'uno');
            io.emit('chatMessage', { sender: 'Система', text: `🔥 ${bot.name} кричит УНО!`, isSystem: true });
        }

        let chosenColor = 'red';
        if (bot.hand[validIndex].color === 'black') {
            const counts = { red: 0, blue: 0, green: 0, yellow: 0 };
            bot.hand.forEach(c => { if (counts[c.color] !== undefined) counts[c.color]++; });
            chosenColor = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
        }

        processCardPlay(pIndex, validIndex, chosenColor, false);
    } else {
        const drawCount = pendingPenalty > 0 ? pendingPenalty : 1;
        bot.hand.push(...drawFromDeck(drawCount));
        bot.saidUno = false;
        pendingPenalty = 0;
        io.emit('playSound', 'card');
        turnIndex = getNextIndex(1);
        broadcastState();
        scheduleBotOrAutopilot();
    }
}

function processCardPlay(pIndex, cardIndex, chosenColor, isIntercept) {
    const player = players[pIndex];
    const card = player.hand[cardIndex];
    if (!card) return;

    if (isIntercept) {
        turnIndex = pIndex;
        io.emit('chatMessage', {
            sender: 'Система',
            text: `⚡ ${player.name} перехватил ход вне очереди!`,
            isSystem: true
        });
    }

    player.hand.splice(cardIndex, 1);
    currentCard = { ...card };

    if (card.color === 'black' && colors.includes(chosenColor)) {
        currentCard.color = chosenColor;
    }

    if (card.type === 'draw2') {
        io.emit('playSound', 'plus2');
    } else if (card.type === 'wild4') {
        io.emit('playSound', 'plus4');
    } else if (card.type === 'wild') {
        io.emit('playSound', 'wild');
    } else {
        io.emit('playSound', 'card');
    }

    if (player.hand.length === 0) {
        if (!roomSettings.catchUno && !player.saidUno) {
            player.hand.push(...drawFromDeck(2));
            if (player.socketId) {
                io.to(player.socketId).emit('alertMsg', 'Вы забыли нажать УНО! Штраф +2 карты.');
            }
        } else {
            finishRound(pIndex);
            return;
        }
    }

    if (player.hand.length > 1) player.saidUno = false;

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
        const victimIndex = getNextIndex(1);
        const victim = players[victimIndex];

        if (roomSettings.stacking) {
            pendingPenalty += 2;
            turnIndex = victimIndex;
            sendAutoSticker(player, victim, '😈', `Накоплено +${pendingPenalty}!`);
        } else {
            victim.hand.push(...drawFromDeck(2));
            victim.saidUno = false;
            sendAutoSticker(player, victim, '😈', 'Лови +2!');
            turnIndex = getNextIndex(2);
        }
    } else if (card.type === 'wild4') {
        const victimIndex = getNextIndex(1);
        const victim = players[victimIndex];

        if (roomSettings.stacking) {
            pendingPenalty += 4;
            turnIndex = victimIndex;
            sendAutoSticker(player, victim, '💀', `Накоплено +${pendingPenalty}!`);
        } else {
            victim.hand.push(...drawFromDeck(4));
            victim.saidUno = false;
            sendAutoSticker(player, victim, '💀', 'Лови +4!');
            turnIndex = getNextIndex(2);
        }
    } else {
        turnIndex = getNextIndex(1);
    }

    broadcastState();
    scheduleBotOrAutopilot();
}

function sendAutoSticker(fromPlayer, toPlayer, emoji, label) {
    if (toPlayer.socketId) {
        io.to(toPlayer.socketId).emit('showSticker', {
            sender: fromPlayer.name,
            emoji,
            text: label,
            isPrivate: true
        });
    }
    if (fromPlayer.socketId) {
        io.to(fromPlayer.socketId).emit('chatMessage', {
            sender: 'Система',
            text: `Вы отправили ${emoji} (${label}) игроку ${toPlayer.name}`,
            isSystem: true
        });
    }
}

function finishRound(winnerIndex) {
    clearInterval(turnInterval);
    clearTimeout(botTimeout);

    const winner = players[winnerIndex];
    let earnedPoints = 0;

    players.forEach((p, idx) => {
        if (idx !== winnerIndex) {
            earnedPoints += calculateHandPoints(p.hand);
        }
    });

    winner.score += earnedPoints;
    io.emit('playSound', 'win');

    const scoreboard = players
        .map(p => ({ name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score);

    if (winner.score >= 250) {
        io.emit('matchOver', {
            winnerName: winner.name,
            earnedPoints,
            scoreboard
        });
        resetAll();
    } else {
        io.emit('roundOver', {
            winnerName: winner.name,
            earnedPoints,
            roundNumber,
            scoreboard
        });

        setTimeout(() => {
            if (players.length < 2) return;
            roundNumber++;
            startNewRound();
        }, 5000);
    }
}

function startNewRound() {
    createDeck();
    direction = 1;
    pendingPenalty = 0;
    turnIndex = (roundNumber - 1) % players.length;

    players.forEach(p => {
        p.hand = drawFromDeck(7);
        p.saidUno = false;
    });

    do {
        currentCard = deck.pop();
    } while (currentCard.color === 'black');

    broadcastState();
    scheduleBotOrAutopilot();
}

function resetAll() {
    clearInterval(turnInterval);
    clearTimeout(botTimeout);
    players = [];
    gameStarted = false;
    currentCard = null;
    roundNumber = 1;
    pendingPenalty = 0;
}

io.on('connection', (socket) => {
    socket.on('checkReconnect', (uid) => {
        const existing = players.find(p => p.uid === uid && !p.isBot);
        socket.emit('reconnectAvailable', {
            available: Boolean(existing && gameStarted),
            name: existing ? existing.name : ''
        });
    });

    socket.on('joinGame', ({ uid, name }) => {
        const existing = players.find(p => p.uid === uid && !p.isBot);

        if (existing) {
            existing.socketId = socket.id;
            existing.autopilot = false;
            if (name && name.trim()) existing.name = name.trim().slice(0, 15);

            io.emit('chatMessage', {
                sender: 'Система',
                text: `🔄 ${existing.name} вернулся за стол и отключил автопилот!`,
                isSystem: true
            });
            broadcastState();
            return;
        }

        if (gameStarted || players.length >= 8) {
            socket.emit('errorMsg', 'Матч уже идет или за столом максимум 8 игроков.');
            return;
        }

        const cleanName = (name || '').trim().slice(0, 15) || `Игрок ${players.length + 1}`;
        players.push({
            uid,
            socketId: socket.id,
            name: cleanName,
            hand: [],
            score: 0,
            saidUno: false,
            isBot: false,
            autopilot: false
        });

        broadcastState();
    });

    socket.on('updateSettings', (newSettings) => {
        if (gameStarted) return;
        roomSettings = { ...roomSettings, ...newSettings };
        broadcastState();
    });

    socket.on('addBot', () => {
        if (gameStarted || players.length >= 8) return;
        const usedNames = players.map(p => p.name);
        const botName = botNames.find(n => !usedNames.includes(n)) || `Бот ${players.length + 1} 🤖`;
        players.push({
            uid: 'bot_' + Math.random().toString(36).slice(2),
            socketId: null,
            name: botName,
            hand: [],
            score: 0,
            saidUno: false,
            isBot: true,
            autopilot: false
        });
        broadcastState();
    });

    socket.on('removeBots', () => {
        if (gameStarted) return;
        players = players.filter(p => !p.isBot);
        broadcastState();
    });

    socket.on('startGame', () => {
        if (gameStarted || players.length < 2) return;
        gameStarted = true;
        roundNumber = 1;
        players.forEach(p => p.score = 0);
        startNewRound();
    });

    socket.on('sayUno', () => {
        const p = players.find(p => p.socketId === socket.id);
        if (p && p.hand.length <= 2 && !p.saidUno) {
            p.saidUno = true;
            io.emit('playSound', 'uno');
            io.emit('chatMessage', { sender: 'Система', text: `🔥 ${p.name} кричит УНО!`, isSystem: true });
            broadcastState();
        }
    });

    socket.on('catchUno', (targetUid) => {
        if (!gameStarted || !roomSettings.catchUno) return;
        const catcher = players.find(p => p.socketId === socket.id);
        const target = players.find(p => p.uid === targetUid);

        if (catcher && target && target.hand.length === 1 && !target.saidUno && catcher.uid !== target.uid) {
            target.hand.push(...drawFromDeck(2));
            io.emit('playSound', 'plus2');
            io.emit('chatMessage', {
                sender: 'Система',
                text: `👀 ${catcher.name} поймал ${target.name} на забытом УНО! Штраф +2 карты!`,
                isSystem: true
            });
            broadcastState();
        }
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        if (!gameStarted) return;
        const pIndex = players.findIndex(p => p.socketId === socket.id);
        if (pIndex === -1) return;

        const player = players[pIndex];
        const card = player.hand[cardIndex];
        if (!card) return;

        const isMyTurn = (pIndex === turnIndex);

        if (!isMyTurn) {
            if (roomSettings.intercept && pendingPenalty === 0 &&
                card.color !== 'black' &&
                card.color === currentCard.color &&
                card.value === currentCard.value) {
                processCardPlay(pIndex, cardIndex, chosenColor, true);
            }
            return;
        }

        if (pendingPenalty > 0 && roomSettings.stacking) {
            if (card.type !== 'draw2' && card.type !== 'wild4') return;
            processCardPlay(pIndex, cardIndex, chosenColor, false);
            return;
        }

        const isValid = card.color === 'black' ||
                        card.color === currentCard.color ||
                        card.value === currentCard.value;

        if (isValid) {
            processCardPlay(pIndex, cardIndex, chosenColor, false);
        }
    });

    socket.on('drawCard', () => {
        if (!gameStarted) return;
        const pIndex = players.findIndex(p => p.socketId === socket.id);
        if (pIndex !== turnIndex) return;

        const drawCount = pendingPenalty > 0 ? pendingPenalty : 1;
        players[pIndex].hand.push(...drawFromDeck(drawCount));
        players[pIndex].saidUno = false;
        pendingPenalty = 0;

        io.emit('playSound', 'card');
        turnIndex = getNextIndex(1);
        broadcastState();
        scheduleBotOrAutopilot();
    });

    socket.on('sendChat', (text) => {
        const p = players.find(p => p.socketId === socket.id);
        if (!p || !text) return;
        const clean = String(text).trim().slice(0, 80);
        if (clean) io.emit('chatMessage', { sender: p.name, text: clean, isSystem: false });
    });

    socket.on('sendSticker', ({ targetUid, emoji, text }) => {
        const sender = players.find(p => p.socketId === socket.id);
        if (!sender) return;

        if (targetUid === 'all') {
            io.emit('showSticker', { sender: sender.name, emoji, text, isPrivate: false });
        } else {
            const target = players.find(p => p.uid === targetUid);
            if (target && target.socketId) {
                io.to(target.socketId).emit('showSticker', { sender: sender.name, emoji, text, isPrivate: true });
                socket.emit('chatMessage', {
                    sender: 'Система',
                    text: `Вы отправили стикер ${emoji} лично для ${target.name}`,
                    isSystem: true
                });
            }
        }
    });

    socket.on('disconnect', () => {
        const idx = players.findIndex(p => p.socketId === socket.id);
        if (idx === -1) return;

        const player = players[idx];
        if (gameStarted) {
            player.socketId = null;
            player.autopilot = true;
            io.emit('chatMessage', {
                sender: 'Система',
                text: `🤖 ${player.name} потерял связь. Включен автопилот (игрок может вернуться).`,
                isSystem: true
            });
            broadcastState();
            if (idx === turnIndex) scheduleBotOrAutopilot();
        } else {
            players.splice(idx, 1);
            broadcastState();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер UNO запущен на порту ${PORT}`));
