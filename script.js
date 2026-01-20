/**
 * BetTracker - Приложение для учета ставок на спорт
 * Использует IndexedDB для локального хранения данных
 */

// ========================================
// Инициализация IndexedDB
// ========================================

const DB_NAME = 'BetTrackerDB';
const STORE_NAME = 'bets';

let db = null;

/**
 * Открытие и инициализация базы данных IndexedDB
 * Автоматически определяет текущую версию БД
 */
function initDB() {
    return new Promise((resolve, reject) => {
        // Сначала открываем БД без указания версии, чтобы узнать текущую
        const checkRequest = indexedDB.open(DB_NAME);
        
        checkRequest.onsuccess = (event) => {
            const existingDb = event.target.result;
            const currentVersion = existingDb.version;
            existingDb.close();
            
            // Проверяем, существует ли нужное хранилище
            const needsUpgrade = !existingDb.objectStoreNames.contains(STORE_NAME);
            const targetVersion = needsUpgrade ? currentVersion + 1 : currentVersion;
            
            // Открываем с нужной версией
            const request = indexedDB.open(DB_NAME, targetVersion);
            
            request.onerror = () => {
                console.error('Ошибка открытия базы данных:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                db = request.result;
                console.log('База данных успешно открыта, версия:', db.version);
                resolve(db);
            };
            
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    const store = database.createObjectStore(STORE_NAME, {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    
                    store.createIndex('status', 'status', { unique: false });
                    store.createIndex('date', 'date', { unique: false });
                    
                    console.log('Хранилище bets создано');
                }
            };
        };
        
        checkRequest.onerror = () => {
            // Если БД не существует, создаем с версией 1
            const request = indexedDB.open(DB_NAME, 1);
            
            request.onerror = () => {
                console.error('Ошибка создания базы данных:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                db = request.result;
                console.log('База данных создана, версия:', db.version);
                resolve(db);
            };
            
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                
                const store = database.createObjectStore(STORE_NAME, {
                    keyPath: 'id',
                    autoIncrement: true
                });
                
                store.createIndex('status', 'status', { unique: false });
                store.createIndex('date', 'date', { unique: false });
                
                console.log('Хранилище bets создано');
            };
        };
    });
}

/**
 * Альтернативный вариант: полная очистка и пересоздание БД
 * Раскомментируйте эту функцию и вызовите вместо initDB(), если проблемы продолжаются
 */
function resetAndInitDB() {
    return new Promise((resolve, reject) => {
        // Удаляем существующую БД
        const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
        
        deleteRequest.onsuccess = () => {
            console.log('Старая база данных удалена');
            
            // Создаем новую БД
            const request = indexedDB.open(DB_NAME, 1);
            
            request.onerror = () => {
                console.error('Ошибка создания базы данных:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                db = request.result;
                console.log('Новая база данных создана');
                resolve(db);
            };
            
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                
                const store = database.createObjectStore(STORE_NAME, {
                    keyPath: 'id',
                    autoIncrement: true
                });
                
                store.createIndex('status', 'status', { unique: false });
                store.createIndex('date', 'date', { unique: false });
            };
        };
        
        deleteRequest.onerror = () => {
            reject(deleteRequest.error);
        };
    });
}

// ========================================
// CRUD операции с базой данных
// ========================================

/**
 * Добавление новой ставки в базу данных
 */
function addBet(bet) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add(bet);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Получение всех ставок из базы данных
 */
function getAllBets() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Получение ставки по ID
 */
function getBetById(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Обновление существующей ставки
 */
function updateBet(bet) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(bet);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Удаление ставки по ID
 */
function deleteBet(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ========================================
// Работа с изображениями
// ========================================

/**
 * Конвертация файла изображения в Base64
 * Важно: выполняется ДО открытия транзакции IndexedDB
 */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// ========================================
// DOM элементы
// ========================================

const elements = {
    // Кнопки
    addBetBtn: document.getElementById('addBetBtn'),
    closeModal: document.getElementById('closeModal'),
    cancelBtn: document.getElementById('cancelBtn'),
    addEventBtn: document.getElementById('addEventBtn'),
    closeViewer: document.getElementById('closeViewer'),
    
    // Модальные окна
    betModal: document.getElementById('betModal'),
    imageViewer: document.getElementById('imageViewer'),
    viewerImage: document.getElementById('viewerImage'),
    
    // Форма
    betForm: document.getElementById('betForm'),
    betId: document.getElementById('betId'),
    eventsList: document.getElementById('eventsList'),
    totalCoef: document.getElementById('totalCoef'),
    betAmount: document.getElementById('betAmount'),
    betStatus: document.getElementById('betStatus'),
    betImage: document.getElementById('betImage'),
    imageGroup: document.getElementById('imageGroup'),
    imagePreview: document.getElementById('imagePreview'),
    modalTitle: document.getElementById('modalTitle'),
    
    // Таблица и фильтр
    betsTableBody: document.getElementById('betsTableBody'),
    statusFilter: document.getElementById('statusFilter'),
    emptyState: document.getElementById('emptyState'),
    
    // Статистика
    totalProfit: document.getElementById('totalProfit'),
    roiValue: document.getElementById('roiValue'),
    winrateValue: document.getElementById('winrateValue'),
    avgCoef: document.getElementById('avgCoef')
};

// ========================================
// Управление событиями в форме
// ========================================

let eventCounter = 0;

/**
 * Создание HTML-карточки события
 */
function createEventCard(event = null) {
    const eventId = eventCounter++;
    const card = document.createElement('div');
    card.className = 'event-card';
    card.dataset.eventId = eventId;
    
    card.innerHTML = `
        <button type="button" class="remove-event-btn" title="Удалить событие">
            <i class="fas fa-times"></i>
        </button>
        <div class="form-group">
            <label>Название события</label>
            <input type="text" class="form-control event-name" placeholder="Команда А vs Команда Б" 
                   value="${event?.name || ''}" required>
        </div>
        <div class="form-group">
            <label>Маркет</label>
            <input type="text" class="form-control event-market" placeholder="П1, ТБ 2.5, Фора -1.5..." 
                   value="${event?.market || ''}" required>
        </div>
        <div class="form-group">
            <label>Коэффициент</label>
            <input type="number" class="form-control event-coef" step="0.01" min="1" 
                   value="${event?.coef || ''}" required>
        </div>
    `;
    
    // Обработчик удаления события
    card.querySelector('.remove-event-btn').addEventListener('click', () => {
        if (elements.eventsList.children.length > 1) {
            card.remove();
            calculateTotalCoef();
        } else {
            alert('Должно быть хотя бы одно событие!');
        }
    });
    
    // Пересчет общего коэффициента при изменении КФ события
    card.querySelector('.event-coef').addEventListener('input', calculateTotalCoef);
    
    return card;
}

/**
 * Расчет общего коэффициента (произведение всех КФ)
 */
function calculateTotalCoef() {
    const coefInputs = elements.eventsList.querySelectorAll('.event-coef');
    let totalCoef = 1;
    
    coefInputs.forEach(input => {
        const value = parseFloat(input.value);
        if (value && value > 0) {
            totalCoef *= value;
        }
    });
    
    elements.totalCoef.value = totalCoef.toFixed(2);
}

/**
 * Сбор данных о событиях из формы
 */
function getEventsFromForm() {
    const events = [];
    const eventCards = elements.eventsList.querySelectorAll('.event-card');
    
    eventCards.forEach(card => {
        events.push({
            name: card.querySelector('.event-name').value.trim(),
            market: card.querySelector('.event-market').value.trim(),
            coef: parseFloat(card.querySelector('.event-coef').value)
        });
    });
    
    return events;
}

// ========================================
// Управление модальными окнами
// ========================================

/**
 * Открытие модального окна для добавления новой ставки
 */
function openAddModal() {
    elements.modalTitle.textContent = 'Новая ставка';
    elements.betId.value = '';
    elements.betForm.reset();
    elements.eventsList.innerHTML = '';
    elements.eventsList.appendChild(createEventCard());
    elements.totalCoef.value = '1.00';
    elements.imageGroup.style.display = 'none';
    elements.imagePreview.innerHTML = '';
    elements.betModal.classList.add('active');
}

/**
 * Открытие модального окна для редактирования ставки
 */
async function openEditModal(id) {
    const bet = await getBetById(id);
    if (!bet) return;
    
    elements.modalTitle.textContent = 'Редактирование ставки';
    elements.betId.value = bet.id;
    elements.betAmount.value = bet.amount;
    elements.betStatus.value = bet.status;
    
    // Заполнение событий
    elements.eventsList.innerHTML = '';
    bet.events.forEach(event => {
        elements.eventsList.appendChild(createEventCard(event));
    });
    calculateTotalCoef();
    
    // Отображение поля для изображения при редактировании
    elements.imageGroup.style.display = 'block';
    elements.betImage.value = '';
    
    // Показ превью существующего изображения
    if (bet.image) {
        elements.imagePreview.innerHTML = `<img src="${bet.image}" alt="Фото чека" onclick="openImageViewer('${bet.image}')">`;
    } else {
        elements.imagePreview.innerHTML = '';
    }
    
    elements.betModal.classList.add('active');
}

/**
 * Закрытие модального окна
 */
function closeModal() {
    elements.betModal.classList.remove('active');
}

/**
 * Открытие полноэкранного просмотра изображения
 */
function openImageViewer(imageSrc) {
    elements.viewerImage.src = imageSrc;
    elements.imageViewer.classList.add('active');
}

/**
 * Закрытие просмотрщика изображений
 */
function closeImageViewer() {
    elements.imageViewer.classList.remove('active');
    elements.viewerImage.src = '';
}

// ========================================
// Обработка формы
// ========================================

/**
 * Сохранение ставки (добавление или обновление)
 */
async function handleFormSubmit(e) {
    e.preventDefault();
    
    const events = getEventsFromForm();
    const totalCoef = parseFloat(elements.totalCoef.value);
    const amount = parseFloat(elements.betAmount.value);
    const status = elements.betStatus.value;
    const betId = elements.betId.value;
    
    // Валидация
    if (events.length === 0) {
        alert('Добавьте хотя бы одно событие!');
        return;
    }
    
    // Подготовка объекта ставки
    const bet = {
        events,
        totalCoef,
        amount,
        status,
        type: events.length > 1 ? 'express' : 'single',
        date: new Date().toISOString()
    };
    
    // Обработка изображения (важно: конвертация ДО транзакции)
    const imageFile = elements.betImage.files[0];
    let imageBase64 = null;
    
    if (imageFile) {
        try {
            imageBase64 = await fileToBase64(imageFile);
        } catch (error) {
            console.error('Ошибка конвертации изображения:', error);
        }
    }
    
    try {
        if (betId) {
            // Обновление существующей ставки
            const existingBet = await getBetById(parseInt(betId));
            bet.id = parseInt(betId);
            bet.date = existingBet.date; // Сохраняем оригинальную дату
            bet.image = imageBase64 || existingBet.image; // Сохраняем старое изображение, если новое не загружено
            await updateBet(bet);
        } else {
            // Добавление новой ставки
            bet.image = null;
            await addBet(bet);
        }
        
        closeModal();
        await renderBets();
        updateStatistics();
    } catch (error) {
        console.error('Ошибка сохранения ставки:', error);
        alert('Произошла ошибка при сохранении ставки');
    }
}

// ========================================
// Отображение ставок в таблице
// ========================================

/**
 * Расчет профита ставки
 */
function calculateProfit(bet) {
    switch (bet.status) {
        case 'win':
            return (bet.amount * bet.totalCoef) - bet.amount;
        case 'lose':
            return -bet.amount;
        case 'return':
            return 0;
        default: // pending
            return 0;
    }
}

/**
 * Форматирование даты
 */
function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Получение текста статуса
 */
function getStatusText(status) {
    const statuses = {
        pending: 'Ожидание',
        win: 'Выигрыш',
        lose: 'Проигрыш',
        return: 'Возврат'
    };
    return statuses[status] || status;
}

/**
 * Создание строки таблицы для ставки
 */
function createBetRow(bet) {
    const profit = calculateProfit(bet);
    const profitClass = profit > 0 ? 'profit-positive' : profit < 0 ? 'profit-negative' : 'profit-neutral';
    const profitText = profit > 0 ? `+${profit.toFixed(2)} ₽` : `${profit.toFixed(2)} ₽`;
    
    const eventsHtml = bet.events.map(event => `
        <div class="event-item">
            <span class="event-name">${event.name}</span>
            <span class="event-market">${event.market} | ${event.coef}</span>
        </div>
    `).join('');
    
    const row = document.createElement('tr');
    row.innerHTML = `
        <td>${formatDate(bet.date)}</td>
        <td>${bet.type === 'express' ? 'Экспресс' : 'Ординар'}</td>
        <td><div class="events-list">${eventsHtml}</div></td>
        <td>${bet.totalCoef.toFixed(2)}</td>
        <td>${bet.amount.toFixed(2)} ₽</td>
        <td class="${profitClass}">${profitText}</td>
        <td><span class="status-badge status-${bet.status}">${getStatusText(bet.status)}</span></td>
        <td class="actions-cell">
            <div class="actions-wrapper">
                ${bet.image ? `<button class="btn btn-icon view" title="Просмотр чека" data-action="view" data-id="${bet.id}">
                    <i class="fas fa-camera"></i>
                </button>` : ''}
                <button class="btn btn-icon edit" title="Редактировать" data-action="edit" data-id="${bet.id}">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-icon delete" title="Удалить" data-action="delete" data-id="${bet.id}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </td>
    `;
    
    return row;
}

/**
 * Отрисовка таблицы ставок
 */
async function renderBets() {
    const filter = elements.statusFilter.value;
    let bets = await getAllBets();
    
    // Применение фильтра
    if (filter !== 'all') {
        bets = bets.filter(bet => bet.status === filter);
    }
    
    // Сортировка по дате (новые сверху)
    bets.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Очистка таблицы
    elements.betsTableBody.innerHTML = '';
    
    // Отображение пустого состояния или таблицы
    if (bets.length === 0) {
        elements.emptyState.classList.add('visible');
        document.querySelector('.table-wrapper').style.display = 'none';
    } else {
        elements.emptyState.classList.remove('visible');
        document.querySelector('.table-wrapper').style.display = 'block';
        
        bets.forEach(bet => {
            elements.betsTableBody.appendChild(createBetRow(bet));
        });
    }
}

// ========================================
// Статистика
// ========================================

/**
 * Обновление статистики на dashboard
 */
async function updateStatistics() {
    const bets = await getAllBets();
    
    // Фильтрация завершенных ставок (не ожидание)
    const completedBets = bets.filter(bet => bet.status !== 'pending');
    const wonBets = bets.filter(bet => bet.status === 'win');
    
    // Общий профит
    const totalProfit = bets.reduce((sum, bet) => sum + calculateProfit(bet), 0);
    elements.totalProfit.textContent = `${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)} ₽`;
    elements.totalProfit.style.color = totalProfit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    
    // ROI (Return on Investment)
    const totalStaked = bets.reduce((sum, bet) => sum + bet.amount, 0);
    const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;
    elements.roiValue.textContent = `${roi.toFixed(1)}%`;
    elements.roiValue.style.color = roi >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    
    // Winrate
    const winrate = completedBets.length > 0 ? (wonBets.length / completedBets.length) * 100 : 0;
    elements.winrateValue.textContent = `${winrate.toFixed(1)}%`;
    
    // Средний коэффициент
    const avgCoef = bets.length > 0 
        ? bets.reduce((sum, bet) => sum + bet.totalCoef, 0) / bets.length 
        : 0;
    elements.avgCoef.textContent = avgCoef.toFixed(2);
}

// ========================================
// Обработчики событий
// ========================================

/**
 * Обработка кликов по кнопкам действий в таблице
 */
async function handleTableActions(e) {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    
    const action = button.dataset.action;
    const id = parseInt(button.dataset.id);
    
    switch (action) {
        case 'view':
            const betForView = await getBetById(id);
            if (betForView?.image) {
                openImageViewer(betForView.image);
            }
            break;
            
        case 'edit':
            openEditModal(id);
            break;
            
        case 'delete':
            if (confirm('Вы уверены, что хотите удалить эту ставку?')) {
                await deleteBet(id);
                await renderBets();
                updateStatistics();
            }
            break;
    }
}

/**
 * Обработка изменения превью изображения
 */
async function handleImageChange(e) {
    const file = e.target.files[0];
    if (file) {
        const base64 = await fileToBase64(file);
        elements.imagePreview.innerHTML = `<img src="${base64}" alt="Превью" onclick="openImageViewer('${base64}')">`;
    }
}

/**
 * Инициализация приложения
 */
async function init() {
    try {
        // Используйте resetAndInitDB() вместо initDB() если нужно сбросить БД
        await initDB();
        // await resetAndInitDB(); // Раскомментируйте для полного сброса
        
        await renderBets();
        updateStatistics();
        
        // Привязка обработчиков событий
        elements.addBetBtn.addEventListener('click', openAddModal);
        elements.closeModal.addEventListener('click', closeModal);
        elements.cancelBtn.addEventListener('click', closeModal);
        elements.addEventBtn.addEventListener('click', () => {
            elements.eventsList.appendChild(createEventCard());
        });
        elements.betForm.addEventListener('submit', handleFormSubmit);
        elements.statusFilter.addEventListener('change', renderBets);
        elements.betsTableBody.addEventListener('click', handleTableActions);
        elements.closeViewer.addEventListener('click', closeImageViewer);
        elements.betImage.addEventListener('change', handleImageChange);
        
        // Закрытие модальных окон по клику на фон
        elements.betModal.addEventListener('click', (e) => {
            if (e.target === elements.betModal) closeModal();
        });
        elements.imageViewer.addEventListener('click', (e) => {
            if (e.target === elements.imageViewer) closeImageViewer();
        });
        
        // Закрытие по Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeModal();
                closeImageViewer();
            }
        });
        
        console.log('BetTracker успешно инициализирован');
    } catch (error) {
        console.error('Ошибка инициализации:', error);
        alert('Произошла ошибка при загрузке приложения. Попробуйте очистить данные сайта.');
    }
}

// Запуск приложения после загрузки DOM
document.addEventListener('DOMContentLoaded', init);

// Глобальная функция для просмотра изображений (вызывается из inline onclick)
window.openImageViewer = openImageViewer;
