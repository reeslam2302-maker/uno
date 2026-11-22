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

// Раздаем index.html и аудиофайлы (plus2.mp3, plus4.mp3, uno.mp3, wild.mp3)
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const colors = ['red', 'blue', 'green', 'yellow'];
const botNames = ['Терминатор 🤖', 'Альтрон 🤖', 'Валли 🤖', 'R2-D2 🤖', 'Бендер 🤖', 'Джарвис 🤖', 'Скайнет 🤖'];

let deck = [];
let players = [];
let currentCard = null;
let turnIndex = 0;
let direction = 1;
let gameStarted = false;
let botTimer = null;

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

function calculateHandPoints(hand) {
    return hand.reduce((sum, card) => {
        if (card.type === 'number') return sum + parseInt(card.value, 10);
        if (card.type === 'wild' || card.type === 'wild4') return sum + 50;
        return sum + 20;
    }, 0);
}

function broadcastState(soundEvent = null) {
    players.forEach((player, index) => {
        if (player.isBot || !player.socketId) return;
        const list = players.map((p, idx) => ({
            uid: p.uid,
            name: p.name,
            count: p.hand.length,
            score: p.score,
            saidUno: p.saidUno,
            isBot: p.isBot,
            disconnected: p.disconnected,
            isTurn: gameStarted && idx === turnIndex,
            isMe: idx === index
        }));

        io.to(player.socketId).emit('gameState', {
            gameStarted,
            hand: player.hand,
            playersList: list,
            saidUno: player.saidUno,
            currentCard,
            direction,
            isMyTurn: gameStarted && index === turnIndex,
            soundEvent
        });
    });
}

function scheduleBotTurn() {
    if (botTimer) clearTimeout(botTimer);
    if (!gameStarted || players.length === 0) return;

    const currentPlayer = players[turnIndex];
    if (!currentPlayer || !currentPlayer.isBot) return;

    botTimer = setTimeout(() => {
        if (!gameStarted || !players[turnIndex] || !players[turnIndex].isBot) return;
        executeBotMove(turnIndex);
    }, 1300);
}

function executeBotMove(botIdx) {
    const bot = players[botIdx];
    const validIndices = [];
    bot.hand.forEach((c, idx) => {
        if (c.color === 'black' || c.color === currentCard.color || c.value === currentCard.value) {
            validIndices.push(idx);
        }
    });

    if (validIndices.length > 0) {
        // Бот старается сначала ходить цветными картами, а черные оставлять напоследок
        validIndices.sort((a, b) => (bot.hand[a].color === 'black' ? 1 : -1));
        const chosenIndex = validIndices[0];
        const card = bot.hand[chosenIndex];

        let chosenColor = 'red';
        if (card.color === 'black') {
            const counts = { red: 0, blue: 0, green: 0, yellow: 0 };
            bot.hand.forEach(c => { if (counts[c.color] !== undefined) counts[c.color]++; });
            chosenColor = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
        }

        if (bot.hand.length === 2) {
            bot.saidUno = true;
            io.emit('chatMessage', { sender: 'Система', text: `🔥 ${bot.name} кричит УНО!`, isSystem: true });
        }

        processPlayCard(botIdx, chosenIndex, chosenColor);
    } else {
        bot.hand.push(...drawFromDeck(1));
        bot.saidUno = false;
        turnIndex = getNextIndex(1);
        broadcastState('draw');
        scheduleBotTurn();
    }
}

function processPlayCard(pIndex, cardIndex, chosenColor) {
    const player = players[pIndex];
    const card = player.hand[cardIndex];
    if (!card) return;

    player.hand.splice(cardIndex, 1);
    currentCard = { ...card };

    let soundToPlay = 'play';

    if (card.color === 'black' && colors.includes(chosenColor)) {
        currentCard.color = chosenColor;
        if (card.type === 'wild') soundToPlay = 'wild';
    }

    if (player.hand.length === 0) {
        if (!player.saidUno && !player.isBot) {
            player.hand.push(...drawFromDeck(2));
            if (player.socketId) {
                io.to(player.socketId).emit('alertMsg', 'Вы забыли нажать УНО! Штраф +2 карты.');
            }
        } else {
            // Подсчет очков за раунд
            let roundPoints = 0;
            players.forEach((p, idx) => {
                if (idx !== pIndex) roundPoints += calculateHandPoints(p.hand);
            });
            player.score += roundPoints;

            if (player.score >= 250) {
                io.emit('matchOver', {
                    winner: player.name,
                    scores: players.map(p => ({ name: p.name, score: p.score }))
                });
                resetFullMatch();
                return;
            } else {
                io.emit('roundOver', {
                    winner: player.name,
                    points: roundPoints,
                    scores: players.map(p => ({ name: p.name, score: p.score }))
                });
                setTimeout(() => startNewRound(), 4500);
                return;
            }
        }
    }

    if (player.hand.length > 1) player.saidUno = false;

    const nextVictim = players[getNextIndex(1)];

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
        soundToPlay = 'plus2';
        nextVictim.hand.push(...drawFromDeck(2));
        nextVictim.saidUno = false;
        sendAutoTaunt(player, nextVictim, '😈 Лови +2!');
        turnIndex = getNextIndex(2);
    } else if (card.type === 'wild4') {
        soundToPlay = 'plus4';
        nextVictim.hand.push(...drawFromDeck(4));
        nextVictim.saidUno = false;
        sendAutoTaunt(player, nextVictim, '💀 Лови +4!');
        turnIndex = getNextIndex(2);
    } else {
        turnIndex = getNextIndex(1);
    }

    broadcastState(soundToPlay);
    scheduleBotTurn();
}

function sendAutoTaunt(sender, victim, text) {
    if (victim.socketId) {
        io.to(victim.socketId).emit('tauntPopup', { from: sender.name, text, isPrivate: true });
    }
    if (sender.socketId) {
        io.to(sender.socketId).emit('chatMessage', {
            sender: 'Система',
            text: `Вы подкинули карту игроку ${victim.name}`,
            isSystem: true
        });
    }
}

function startNewRound() {
    if (players.length < 2) return;
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

    broadcastState('play');
    scheduleBotTurn();
}

function resetFullMatch() {
    if (botTimer) clearTimeout(botTimer);
    players = [];
    gameStarted = false;
    currentCard = null;
}

io.on('connection', (socket) => {
    socket.on('joinOnline', ({ uid, name }) => {
        // Проверка переподключения
        const existing = players.find(p => p.uid === uid && !p.isBot);
        if (existing) {
            if (existing.disconnectTimer) clearTimeout(existing.disconnectTimer);
            existing.socketId = socket.id;
            existing.disconnected = false;
            broadcastState();
            return;
        }

        if (gameStarted || players.length >= 8) {
            socket.emit('errorMsg', 'Онлайн-матч уже идет или стол заполнен (макс. 8 игроков).');
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
            disconnected: false
        });
        broadcastState();
    });

    socket.on('addBot', () => {
        if (gameStarted || players.length >= 8) return;
        const usedNames = players.map(p => p.name);
        const freeName = botNames.find(n => !usedNames.includes(n)) || `Бот ${players.length + 1} 🤖`;
        players.push({
            uid: 'bot_' + Math.random().toString(36).slice(2),
            socketId: null,
            name: freeName,
            hand: [],
            score: 0,
            saidUno: false,
            isBot: true,
            disconnected: false
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
        startNewRound();
    });

    socket.on('sayUno', () => {
        const p = players.find(p => p.socketId === socket.id);
        if (p && p.hand.length <= 2 && !p.saidUno) {
            p.saidUno = true;
            io.emit('chatMessage', { sender: 'Система', text: `🔥 ${p.name} кричит УНО!`, isSystem: true });
            broadcastState('uno');
        }
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        if (!gameStarted) return;
        const pIndex = players.findIndex(p => p.socketId === socket.id);
        if (pIndex !== turnIndex) return;

        const card = players[pIndex].hand[cardIndex];
        if (!card) return;

        const isValid = card.color === 'black' ||
                        card.color === currentCard.color ||
                        card.value === currentCard.value;
        if (!isValid) return;

        processPlayCard(pIndex, cardIndex, chosenColor);
    });

    socket.on('drawCard', () => {
        if (!gameStarted) return;
        const pIndex = players.findIndex(p => p.socketId === socket.id);
        if (pIndex !== turnIndex) return;

        players[pIndex].hand.push(...drawFromDeck(1));
        players[pIndex].saidUno = false;
        turnIndex = getNextIndex(1);
        broadcastState('draw');
        scheduleBotTurn();
    });

    socket.on('sendChat', (text) => {
        const p = players.find(p => p.socketId === socket.id);
        if (!p || !text) return;
        const clean = String(text).trim().slice(0, 80);
        if (clean) io.emit('chatMessage', { sender: p.name, text: clean, isSystem: false });
    });

    socket.on('sendTaunt', ({ targetUid, text }) => {
        const sender = players.find(p => p.socketId === socket.id);
        if (!sender || !text) return;

        if (targetUid === 'all') {
            io.emit('tauntPopup', { from: sender.name, text, isPrivate: false });
        } else {
            const target = players.find(p => p.uid === targetUid);
            if (target && target.socketId) {
                io.to(target.socketId).emit('tauntPopup', { from: sender.name, text, isPrivate: true });
                socket.emit('chatMessage', {
                    sender: 'Система',
                    text: `Стикер «${text}» отправлен лично игроку ${target.name}`,
                    isSystem: true
                });
            }
        }
    });

    socket.on('disconnect', () => {
        const pIndex = players.findIndex(p => p.socketId === socket.id);
        if (pIndex === -1) return;

        const player = players[pIndex];
        if (!gameStarted) {
            players.splice(pIndex, 1);
            if (players.every(p => p.isBot)) players = [];
            broadcastState();
        } else {
            player.disconnected = true;
            broadcastState();
            player.disconnectTimer = setTimeout(() => {
                const idx = players.findIndex(p => p.uid === player.uid);
                if (idx !== -1 && players[idx].disconnected) {
                    const leftName = players[idx].name;
                    players.splice(idx, 1);
                    const realHumans = players.filter(p => !p.isBot);
                    if (realHumans.length === 0 || players.length < 2) {
                        io.emit('errorMsg', `Игрок ${leftName} не вернулся. Матч завершен.`);
                        resetFullMatch();
                    } else {
                        if (turnIndex >= players.length) turnIndex = 0;
                        broadcastState();
                        scheduleBotTurn();
                    }
                }
            }, 45000);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер UNO запущен на порту ${PORT}`));
