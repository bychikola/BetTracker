/**
 * BetTracker - Приложение для учета ставок на спорт
 * Использует Supabase для хранения данных в облаке
 */

// ========================================
// Конфигурация Supabase
// ========================================

// !!! ЗАМЕНИТЕ НА СВОИ ДАННЫЕ ИЗ SUPABASE !!!
const SUPABASE_URL = 'https://jmpgnclsmjtkxhgsybks.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImptcGduY2xzbWp0a3hoZ3N5YmtzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5NjAwNDIsImV4cCI6MjA4NDUzNjA0Mn0.yBcfMVJujxelHXrI8TFCp2G7cjcposNkwYxVORXrSZk';

// Проверка конфигурации
const isConfigured = !SUPABASE_URL.includes('YOUR_PROJECT_ID');

// ========================================
// Supabase клиент (простая реализация без SDK)
// ========================================

class SupabaseClient {
    constructor(url, key) {
        this.url = url;
        this.key = key;
        this.headers = {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };
    }

    async request(endpoint, options = {}) {
        const response = await fetch(`${this.url}/rest/v1/${endpoint}`, {
            ...options,
            headers: { ...this.headers, ...options.headers }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Unknown error' }));
            throw new Error(error.message || 'Ошибка запроса к базе данных');
        }

        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }

    // Получить все записи
    async getAll(table, filters = {}) {
        let query = table + '?select=*';
        
        if (filters.status && filters.status !== 'all') {
            query += `&status=eq.${filters.status}`;
        }
        
        query += '&order=created_at.desc';
        
        return this.request(query);
    }

    // Получить запись по ID
    async getById(table, id) {
        const data = await this.request(`${table}?id=eq.${id}`);
        return data?.[0] || null;
    }

    // Создать запись
    async create(table, data) {
        const result = await this.request(table, {
            method: 'POST',
            body: JSON.stringify(data)
        });
        return result?.[0];
    }

    // Обновить запись
    async update(table, id, data) {
        const result = await this.request(`${table}?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });
        return result?.[0];
    }

    // Удалить запись
    async delete(table, id) {
        await this.request(`${table}?id=eq.${id}`, {
            method: 'DELETE'
        });
    }
}

// Инициализация клиента
const supabase = new SupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ========================================
// Локальный кэш (IndexedDB как fallback)
// ========================================

const DB_NAME = 'BetTrackerCache';
const STORE_NAME = 'bets';
let localDb = null;

async function initLocalDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            localDb = request.result;
            resolve(localDb);
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
    });
}

async function saveToLocalCache(bets) {
    if (!localDb) return;
    
    return new Promise((resolve, reject) => {
        const transaction = localDb.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        // Очищаем и сохраняем заново
        const clearRequest = store.clear();
        
        clearRequest.onsuccess = () => {
            bets.forEach(bet => store.add(bet));
            resolve();
        };
        
        clearRequest.onerror = () => reject(clearRequest.error);
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

async function getFromLocalCache() {
    if (!localDb) return [];
    
    return new Promise((resolve) => {
        const transaction = localDb.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
    });
}

// ========================================
// API функции
// ========================================

let betsCache = [];
let isOnline = navigator.onLine;

/**
 * Преобразование данных из БД в формат приложения
 */
function formatBetFromDB(bet) {
    if (!bet) return null;
    
    return {
        id: bet.id,
        events: Array.isArray(bet.events) ? bet.events : JSON.parse(bet.events || '[]'),
        totalCoef: parseFloat(bet.total_coef) || 0,
        amount: parseFloat(bet.amount) || 0,
        status: bet.status || 'pending',
        type: bet.type || 'single',
        image: bet.image || null,
        date: bet.created_at || new Date().toISOString()
    };
}

/**
 * Получение всех ставок
 */
async function getAllBets(filter = 'all') {
    if (!isConfigured) {
        console.log('Supabase не настроен, используем локальный кэш');
        const cached = await getFromLocalCache();
        if (filter !== 'all') {
            return cached.filter(bet => bet.status === filter);
        }
        return cached;
    }

    try {
        console.log('Загрузка ставок из Supabase...');
        const bets = await supabase.getAll('bets', { status: filter });
        console.log('Получено ставок:', bets?.length || 0);
        
        if (!bets || !Array.isArray(bets)) {
            console.warn('Получены некорректные данные:', bets);
            return [];
        }
        
        // Преобразуем данные из БД в формат приложения
        const formattedBets = bets.map(formatBetFromDB).filter(bet => bet !== null);
        console.log('Отформатированные ставки:', formattedBets);
        
        // Сохраняем в локальный кэш
        if (filter === 'all') {
            betsCache = formattedBets;
            await saveToLocalCache(formattedBets);
        }
        
        return formattedBets;
    } catch (error) {
        console.error('Ошибка загрузки данных:', error);
        showToast('Ошибка загрузки. Показаны кэшированные данные.', 'warning');
        const cached = await getFromLocalCache();
        if (filter !== 'all') {
            return cached.filter(bet => bet.status === filter);
        }
        return cached;
    }
}

/**
 * Получение ставки по ID
 */
async function getBetById(id) {
    if (!isConfigured) {
        const cached = await getFromLocalCache();
        return cached.find(b => b.id === id) || null;
    }

    try {
        const bet = await supabase.getById('bets', id);
        return formatBetFromDB(bet);
    } catch (error) {
        console.error('Ошибка получения ставки:', error);
        return null;
    }
}

/**
 * Добавление новой ставки
 */
async function addBet(bet) {
    const dbBet = {
        events: bet.events,
        total_coef: bet.totalCoef,
        amount: bet.amount,
        status: bet.status,
        type: bet.type,
        image: bet.image || null
    };

    if (!isConfigured) {
        // Локальное сохранение
        const cached = await getFromLocalCache();
        const newId = cached.length > 0 ? Math.max(...cached.map(b => b.id || 0)) + 1 : 1;
        const newBet = { ...bet, id: newId, date: new Date().toISOString() };
        cached.unshift(newBet);
        await saveToLocalCache(cached);
        return newBet;
    }

    try {
        console.log('Добавление ставки в Supabase:', dbBet);
        const result = await supabase.create('bets', dbBet);
        console.log('Результат добавления:', result);
        return formatBetFromDB(result);
    } catch (error) {
        console.error('Ошибка добавления ставки:', error);
        throw error;
    }
}

/**
 * Обновление ставки
 */
async function updateBet(bet) {
    const dbBet = {
        events: bet.events,
        total_coef: bet.totalCoef,
        amount: bet.amount,
        status: bet.status,
        type: bet.type,
        image: bet.image,
        updated_at: new Date().toISOString()
    };

    if (!isConfigured) {
        const cached = await getFromLocalCache();
        const index = cached.findIndex(b => b.id === bet.id);
        if (index !== -1) {
            cached[index] = { ...cached[index], ...bet };
            await saveToLocalCache(cached);
        }
        return bet;
    }

    try {
        const result = await supabase.update('bets', bet.id, dbBet);
        return formatBetFromDB(result);
    } catch (error) {
        console.error('Ошибка обновления ставки:', error);
        throw error;
    }
}

/**
 * Удаление ставки
 */
async function deleteBet(id) {
    if (!isConfigured) {
        const cached = await getFromLocalCache();
        const filtered = cached.filter(b => b.id !== id);
        await saveToLocalCache(filtered);
        return;
    }

    try {
        await supabase.delete('bets', id);
    } catch (error) {
        console.error('Ошибка удаления ставки:', error);
        throw error;
    }
}

// ========================================
// Работа с изображениями
// ========================================

/**
 * Конвертация файла в Base64 с сжатием
 */
function fileToBase64(file, maxWidth = 800) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        
        reader.onload = (e) => {
            const img = new Image();
            
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                
                // Сжимаем если больше maxWidth
                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }
                
                canvas.width = width;
                canvas.height = height;
                
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // Конвертируем в JPEG с качеством 0.7
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            };
            
            img.onerror = reject;
            img.src = e.target.result;
        };
        
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ========================================
// DOM элементы
// ========================================

const elements = {
    // Загрузка и статус
    loadingOverlay: document.getElementById('loadingOverlay'),
    connectionStatus: document.getElementById('connectionStatus'),
    
    // Кнопки
    addBetBtn: document.getElementById('addBetBtn'),
    syncBtn: document.getElementById('syncBtn'),
    closeModal: document.getElementById('closeModal'),
    cancelBtn: document.getElementById('cancelBtn'),
    addEventBtn: document.getElementById('addEventBtn'),
    closeViewer: document.getElementById('closeViewer'),
    submitBtn: document.getElementById('submitBtn'),
    
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
    
    // Таблица и карточки
    betsTableBody: document.getElementById('betsTableBody'),
    mobileCards: document.getElementById('mobileCards'),
    statusFilter: document.getElementById('statusFilter'),
    emptyState: document.getElementById('emptyState'),
    betsSection: document.querySelector('.bets-section'),
    tableWrapper: document.querySelector('.table-wrapper'),
    
    // Статистика
    totalProfit: document.getElementById('totalProfit'),
    roiValue: document.getElementById('roiValue'),
    winrateValue: document.getElementById('winrateValue'),
    avgCoef: document.getElementById('avgCoef'),
    
    // Уведомления
    toastContainer: document.getElementById('toastContainer')
};

// ========================================
// Уведомления
// ========================================

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };
    
    toast.innerHTML = `
        <i class="fas ${icons[type] || icons.info}"></i>
        <span class="toast-message">${message}</span>
    `;
    
    elements.toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ========================================
// Статус подключения
// ========================================

function updateConnectionStatus() {
    const status = elements.connectionStatus;
    
    if (!isConfigured) {
        status.innerHTML = '<i class="fas fa-database"></i><span>Локально</span>';
        status.className = 'connection-status local';
    } else if (isOnline) {
        status.innerHTML = '<i class="fas fa-cloud"></i><span>Онлайн</span>';
        status.className = 'connection-status';
    } else {
        status.innerHTML = '<i class="fas fa-cloud-slash"></i><span>Офлайн</span>';
        status.className = 'connection-status offline';
    }
}

// ========================================
// Управление событиями в форме
// ========================================

let eventCounter = 0;
let currentImageBase64 = null;

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
            <input type="text" class="form-control event-market" placeholder="П1, ТБ 2.5, Фора..." 
                   value="${event?.market || ''}" required>
        </div>
        <div class="form-group">
            <label>Коэффициент</label>
            <input type="number" class="form-control event-coef" step="0.01" min="1" 
                   value="${event?.coef || ''}" required>
        </div>
    `;
    
    card.querySelector('.remove-event-btn').addEventListener('click', () => {
        if (elements.eventsList.children.length > 1) {
            card.remove();
            calculateTotalCoef();
        } else {
            showToast('Должно быть хотя бы одно событие!', 'warning');
        }
    });
    
    card.querySelector('.event-coef').addEventListener('input', calculateTotalCoef);
    
    return card;
}

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

function getEventsFromForm() {
    const events = [];
    const eventCards = elements.eventsList.querySelectorAll('.event-card');
    
    eventCards.forEach(card => {
        const name = card.querySelector('.event-name').value.trim();
        const market = card.querySelector('.event-market').value.trim();
        const coef = parseFloat(card.querySelector('.event-coef').value);
        
        if (name && market && coef) {
            events.push({ name, market, coef });
        }
    });
    
    return events;
}

// ========================================
// Управление модальными окнами
// ========================================

function openAddModal() {
    elements.modalTitle.textContent = 'Новая ставка';
    elements.betId.value = '';
    elements.betForm.reset();
    elements.eventsList.innerHTML = '';
    elements.eventsList.appendChild(createEventCard());
    elements.totalCoef.value = '1.00';
    elements.imagePreview.innerHTML = '';
    currentImageBase64 = null;
    elements.betModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

async function openEditModal(id) {
    const bet = await getBetById(id);
    if (!bet) {
        showToast('Ставка не найдена', 'error');
        return;
    }
    
    elements.modalTitle.textContent = 'Редактирование';
    elements.betId.value = bet.id;
    elements.betAmount.value = bet.amount;
    elements.betStatus.value = bet.status;
    
    elements.eventsList.innerHTML = '';
    if (bet.events && Array.isArray(bet.events)) {
        bet.events.forEach(event => {
            elements.eventsList.appendChild(createEventCard(event));
        });
    } else {
        elements.eventsList.appendChild(createEventCard());
    }
    calculateTotalCoef();
    
    elements.betImage.value = '';
    currentImageBase64 = bet.image || null;
    
    if (bet.image) {
        elements.imagePreview.innerHTML = `
            <img src="${bet.image}" alt="Фото чека" onclick="openImageViewer(this.src)">
            <span class="remove-image" onclick="removeImage()"><i class="fas fa-trash"></i> Удалить фото</span>
        `;
    } else {
        elements.imagePreview.innerHTML = '';
    }
    
    elements.betModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    elements.betModal.classList.remove('active');
    document.body.style.overflow = '';
}

function openImageViewer(imageSrc) {
    elements.viewerImage.src = imageSrc;
    elements.imageViewer.classList.add('active');
}

function closeImageViewer() {
    elements.imageViewer.classList.remove('active');
    elements.viewerImage.src = '';
}

function removeImage() {
    currentImageBase64 = null;
    elements.imagePreview.innerHTML = '';
    elements.betImage.value = '';
}

// Глобальные функции для inline обработчиков
window.openImageViewer = openImageViewer;
window.removeImage = removeImage;

// ========================================
// Обработка формы
// ========================================

async function handleFormSubmit(e) {
    e.preventDefault();
    
    const submitBtn = elements.submitBtn;
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoading = submitBtn.querySelector('.btn-loading');
    
    // Показываем загрузку
    submitBtn.disabled = true;
    btnText.style.display = 'none';
    btnLoading.style.display = 'inline';
    
    try {
        const events = getEventsFromForm();
        const totalCoef = parseFloat(elements.totalCoef.value);
        const amount = parseFloat(elements.betAmount.value);
        const status = elements.betStatus.value;
        const betId = elements.betId.value;
        
        if (events.length === 0) {
            showToast('Добавьте хотя бы одно событие!', 'warning');
            return;
        }
        
        // Обработка изображения
        const imageFile = elements.betImage.files[0];
        if (imageFile) {
            currentImageBase64 = await fileToBase64(imageFile);
        }
        
        const bet = {
            events,
            totalCoef,
            amount,
            status,
            type: events.length > 1 ? 'express' : 'single',
            image: currentImageBase64
        };
        
        if (betId) {
            bet.id = parseInt(betId);
            const existingBet = await getBetById(bet.id);
            bet.date = existingBet?.date;
            await updateBet(bet);
            showToast('Ставка обновлена!', 'success');
        } else {
            await addBet(bet);
            showToast('Ставка добавлена!', 'success');
        }
        
        closeModal();
        await renderBets();
        await updateStatistics();
        
    } catch (error) {
        console.error('Ошибка сохранения:', error);
        showToast('Ошибка сохранения ставки', 'error');
    } finally {
        submitBtn.disabled = false;
        btnText.style.display = 'inline';
        btnLoading.style.display = 'none';
    }
}

// ========================================
// Отображение ставок
// ========================================

function calculateProfit(bet) {
    const amount = parseFloat(bet.amount) || 0;
    const totalCoef = parseFloat(bet.totalCoef) || 0;
    
    switch (bet.status) {
        case 'win':
            return (amount * totalCoef) - amount;
        case 'lose':
            return -amount;
        default:
            return 0;
    }
}

function formatDate(isoString) {
    if (!isoString) return 'Н/Д';
    
    try {
        const date = new Date(isoString);
        return date.toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return 'Н/Д';
    }
}

function getStatusText(status) {
    const statuses = {
        pending: 'Ожидание',
        win: 'Выигрыш',
        lose: 'Проигрыш',
        return: 'Возврат'
    };
    return statuses[status] || status;
}

function createBetRow(bet) {
    const profit = calculateProfit(bet);
    const profitClass = profit > 0 ? 'profit-positive' : profit < 0 ? 'profit-negative' : 'profit-neutral';
    const profitText = profit > 0 ? `+${profit.toFixed(0)}₽` : `${profit.toFixed(0)}₽`;
    
    const events = Array.isArray(bet.events) ? bet.events : [];
    const eventsHtml = events.map(event => `
        <div class="event-item">
            <span class="event-name">${event.name || 'Без названия'}</span>
            <span class="event-market">${event.market || ''} @ ${event.coef || 0}</span>
        </div>
    `).join('');
    
    const row = document.createElement('tr');
    row.innerHTML = `
        <td>${formatDate(bet.date)}</td>
        <td>${bet.type === 'express' ? 'Экспресс' : 'Ординар'}</td>
        <td><div class="events-list">${eventsHtml || '<em>Нет событий</em>'}</div></td>
        <td>${(bet.totalCoef || 0).toFixed(2)}</td>
        <td>${(bet.amount || 0).toFixed(0)}₽</td>
        <td class="${profitClass}">${profitText}</td>
        <td><span class="status-badge status-${bet.status}">${getStatusText(bet.status)}</span></td>
        <td class="actions-cell">
            <div class="actions-wrapper">
                ${bet.image ? `<button class="btn btn-icon view" title="Фото" data-action="view" data-id="${bet.id}">
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

function createBetCard(bet) {
    const profit = calculateProfit(bet);
    const profitClass = profit > 0 ? 'profit-positive' : profit < 0 ? 'profit-negative' : 'profit-neutral';
    const profitText = profit > 0 ? `+${profit.toFixed(0)}₽` : `${profit.toFixed(0)}₽`;
    
    const events = Array.isArray(bet.events) ? bet.events : [];
    const eventsHtml = events.map(event => `
        <div class="bet-card-event">
            <div class="bet-card-event-name">${event.name || 'Без названия'}</div>
            <div class="bet-card-event-market">${event.market || ''} @ ${event.coef || 0}</div>
        </div>
    `).join('');
    
    const card = document.createElement('div');
    card.className = `bet-card status-${bet.status}`;
    card.innerHTML = `
        <div class="bet-card-header">
            <span class="bet-card-date">${formatDate(bet.date)}</span>
            <span class="bet-card-type">${bet.type === 'express' ? 'Экспресс' : 'Ординар'}</span>
        </div>
        <div class="bet-card-events">${eventsHtml || '<em>Нет событий</em>'}</div>
        <div class="bet-card-stats">
            <div class="bet-card-stat">
                <div class="bet-card-stat-label">Коэф</div>
                <div class="bet-card-stat-value">${(bet.totalCoef || 0).toFixed(2)}</div>
            </div>
            <div class="bet-card-stat">
                <div class="bet-card-stat-label">Сумма</div>
                <div class="bet-card-stat-value">${(bet.amount || 0).toFixed(0)}₽</div>
            </div>
            <div class="bet-card-stat">
                <div class="bet-card-stat-label">Профит</div>
                <div class="bet-card-stat-value ${profitClass}">${profitText}</div>
            </div>
        </div>
        <div class="bet-card-footer">
            <span class="status-badge status-${bet.status}">${getStatusText(bet.status)}</span>
            <div class="bet-card-actions">
                ${bet.image ? `<button class="btn btn-icon view" data-action="view" data-id="${bet.id}">
                    <i class="fas fa-camera"></i>
                </button>` : ''}
                <button class="btn btn-icon edit" data-action="edit" data-id="${bet.id}">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-icon delete" data-action="delete" data-id="${bet.id}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `;
    
    return card;
}

async function renderBets() {
    console.log('Рендеринг ставок...');
    
    const filter = elements.statusFilter.value;
    let bets = [];
    
    try {
        bets = await getAllBets(filter);
        console.log('Ставки для рендеринга:', bets);
    } catch (error) {
        console.error('Ошибка получения ставок:', error);
        bets = [];
    }
    
    // Очистка
    elements.betsTableBody.innerHTML = '';
    elements.mobileCards.innerHTML = '';
    
    if (!bets || bets.length === 0) {
        console.log('Нет ставок для отображения');
        elements.emptyState.classList.add('visible');
        elements.betsSection.classList.add('empty');
        if (elements.tableWrapper) {
            elements.tableWrapper.style.display = 'none';
        }
        elements.mobileCards.style.display = 'none';
    } else {
        console.log(`Отображаем ${bets.length} ставок`);
        elements.emptyState.classList.remove('visible');
        elements.betsSection.classList.remove('empty');
        
        // Показываем таблицу/карточки в зависимости от ширины экрана
        if (window.innerWidth >= 900) {
            if (elements.tableWrapper) {
                elements.tableWrapper.style.display = 'block';
            }
            elements.mobileCards.style.display = 'none';
        } else {
            if (elements.tableWrapper) {
                elements.tableWrapper.style.display = 'none';
            }
            elements.mobileCards.style.display = 'flex';
        }
        
        bets.forEach(bet => {
            try {
                elements.betsTableBody.appendChild(createBetRow(bet));
                elements.mobileCards.appendChild(createBetCard(bet));
            } catch (error) {
                console.error('Ошибка рендеринга ставки:', bet, error);
            }
        });
    }
}

// ========================================
// Статистика
// ========================================

async function updateStatistics() {
    let bets = [];
    
    try {
        bets = await getAllBets('all');
    } catch (error) {
        console.error('Ошибка получения статистики:', error);
        bets = [];
    }
    
    if (!bets || bets.length === 0) {
        elements.totalProfit.textContent = '0₽';
        elements.totalProfit.style.color = 'var(--text-secondary)';
        elements.roiValue.textContent = '0%';
        elements.roiValue.style.color = 'var(--text-secondary)';
        elements.winrateValue.textContent = '0%';
        elements.avgCoef.textContent = '0.00';
        return;
    }
    
    const completedBets = bets.filter(bet => bet.status !== 'pending');
    const wonBets = bets.filter(bet => bet.status === 'win');
    
    // Общий профит
    const totalProfit = bets.reduce((sum, bet) => sum + calculateProfit(bet), 0);
    elements.totalProfit.textContent = `${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(0)}₽`;
    elements.totalProfit.style.color = totalProfit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    
    // ROI
    const totalStaked = bets.reduce((sum, bet) => sum + (parseFloat(bet.amount) || 0), 0);
    const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;
    elements.roiValue.textContent = `${roi.toFixed(1)}%`;
    elements.roiValue.style.color = roi >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    
    // Winrate
    const winrate = completedBets.length > 0 ? (wonBets.length / completedBets.length) * 100 : 0;
    elements.winrateValue.textContent = `${winrate.toFixed(1)}%`;
    
    // Средний КФ
    const avgCoef = bets.length > 0 
        ? bets.reduce((sum, bet) => sum + (parseFloat(bet.totalCoef) || 0), 0) / bets.length 
        : 0;
    elements.avgCoef.textContent = avgCoef.toFixed(2);
}

// ========================================
// Обработчики событий
// ========================================

async function handleTableActions(e) {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    
    const action = button.dataset.action;
    const id = parseInt(button.dataset.id);
    
    console.log('Действие:', action, 'ID:', id);
    
    switch (action) {
        case 'view':
            const betForView = await getBetById(id);
            if (betForView?.image) {
                openImageViewer(betForView.image);
            }
            break;
            
        case 'edit':
            await openEditModal(id);
            break;
            
        case 'delete':
            if (confirm('Удалить эту ставку?')) {
                try {
                    await deleteBet(id);
                    showToast('Ставка удалена', 'success');
                    await renderBets();
                    await updateStatistics();
                } catch (error) {
                    showToast('Ошибка удаления', 'error');
                }
            }
            break;
    }
}

async function handleImageChange(e) {
    const file = e.target.files[0];
    if (file) {
        try {
            const base64 = await fileToBase64(file);
            currentImageBase64 = base64;
            elements.imagePreview.innerHTML = `
                <img src="${base64}" alt="Превью" onclick="openImageViewer(this.src)">
                <span class="remove-image" onclick="removeImage()"><i class="fas fa-trash"></i> Удалить</span>
            `;
        } catch (error) {
            showToast('Ошибка загрузки изображения', 'error');
        }
    }
}

async function syncData() {
    const syncBtn = elements.syncBtn;
    syncBtn.disabled = true;
    syncBtn.querySelector('i').classList.add('fa-spin');
    
    elements.connectionStatus.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i><span>Синхронизация...</span>';
    elements.connectionStatus.className = 'connection-status syncing';
    
    try {
        await renderBets();
        await updateStatistics();
        showToast('Данные синхронизированы', 'success');
    } catch (error) {
        showToast('Ошибка синхронизации', 'error');
    } finally {
        syncBtn.disabled = false;
        syncBtn.querySelector('i').classList.remove('fa-spin');
        updateConnectionStatus();
    }
}

// ========================================
// Обработка изменения размера окна
// ========================================

function handleResize() {
    const hasBets = elements.betsTableBody.children.length > 0;
    
    if (!hasBets) return;
    
    if (window.innerWidth >= 900) {
        if (elements.tableWrapper) {
            elements.tableWrapper.style.display = 'block';
        }
        elements.mobileCards.style.display = 'none';
    } else {
        if (elements.tableWrapper) {
            elements.tableWrapper.style.display = 'none';
        }
        elements.mobileCards.style.display = 'flex';
    }
}

// ========================================
// Инициализация
// ========================================

async function init() {
    try {
        console.log('Инициализация приложения...');
        
        // Инициализация локального кэша
        await initLocalDB();
        console.log('Локальная БД инициализирована');
        
        // Проверка конфигурации
        if (!isConfigured) {
            console.warn('Supabase не настроен. Работа в локальном режиме.');
            showToast('Работа в локальном режиме. Настройте Supabase для синхронизации.', 'warning');
        }
        
        // Обновление статуса подключения
        updateConnectionStatus();
        
        // Загрузка и отображение данных
        await renderBets();
        await updateStatistics();
        
        // Привязка обработчиков
        elements.addBetBtn.addEventListener('click', openAddModal);
        elements.syncBtn.addEventListener('click', syncData);
        elements.closeModal.addEventListener('click', closeModal);
        elements.cancelBtn.addEventListener('click', closeModal);
        elements.addEventBtn.addEventListener('click', () => {
            elements.eventsList.appendChild(createEventCard());
        });
        elements.betForm.addEventListener('submit', handleFormSubmit);
        elements.statusFilter.addEventListener('change', renderBets);
        elements.betsTableBody.addEventListener('click', handleTableActions);
        elements.mobileCards.addEventListener('click', handleTableActions);
        elements.closeViewer.addEventListener('click', closeImageViewer);
        elements.betImage.addEventListener('change', handleImageChange);
        
        // Обработка изменения размера окна
        window.addEventListener('resize', handleResize);
        
        // Закрытие модальных окон
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
        
        // Отслеживание онлайн/офлайн статуса
        window.addEventListener('online', () => {
            isOnline = true;
            updateConnectionStatus();
            showToast('Подключение восстановлено', 'success');
            syncData();
        });
        
        window.addEventListener('offline', () => {
            isOnline = false;
            updateConnectionStatus();
            showToast('Нет подключения к интернету', 'warning');
        });
        
        // Скрываем загрузку
        elements.loadingOverlay.classList.add('hidden');
        
        console.log('BetTracker инициализирован успешно');
        
    } catch (error) {
        console.error('Ошибка инициализации:', error);
        elements.loadingOverlay.innerHTML = `
            <i class="fas fa-exclamation-triangle" style="font-size: 3rem; color: var(--accent-red);"></i>
            <p>Ошибка загрузки приложения</p>
            <p style="font-size: 0.8rem; color: var(--text-secondary);">${error.message}</p>
            <button class="btn btn-primary" onclick="location.reload()" style="margin-top: 20px;">Перезагрузить</button>
        `;
    }
}

// Запуск
document.addEventListener('DOMContentLoaded', init);
