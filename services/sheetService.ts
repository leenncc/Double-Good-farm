
import { MushroomBatch, BatchStatus, ApiResponse, InventoryItem, PurchaseOrder, SalesRecord, Customer, FinishedGood, SalesStatus, PaymentMethod, DailyCostMetrics, Supplier, Recipe, UserRole, Budget } from '../types';
import { db, auth, storage } from './firebase';
import firebase from 'firebase/compat/app';

// ============================================================================
// CONFIGURATION MANAGEMENT
// ============================================================================
const FIXED_SCRIPT_URL = ''; 
const FIXED_SHEET_URL = '';
const STORAGE_KEY_URL = 'shroomtrack_api_url';
const STORAGE_KEY_SHEET_URL = 'shroomtrack_sheet_url';
const STORAGE_KEY_MOCK = 'shroomtrack_use_mock';
const STORAGE_KEY_LABOR_RATE = 'shroomtrack_labor_rate';
const STORAGE_KEY_RAW_RATE = 'shroomtrack_raw_rate';
const STORAGE_KEY_THEME = 'shroomtrack_theme';

export const getAppSettings = () => {
  const storedUrl = localStorage.getItem(STORAGE_KEY_URL);
  const storedSheetUrl = localStorage.getItem(STORAGE_KEY_SHEET_URL);
  const storedMock = localStorage.getItem(STORAGE_KEY_MOCK);
  return {
    scriptUrl: FIXED_SCRIPT_URL || storedUrl || '',
    sheetUrl: FIXED_SHEET_URL || storedSheetUrl || '',
    useMock: storedMock === 'true',
    isFixed: FIXED_SCRIPT_URL !== ''
  };
};

export const saveAppSettings = (url: string, sheetUrl: string, useMock: boolean) => {
  localStorage.setItem(STORAGE_KEY_URL, url);
  localStorage.setItem(STORAGE_KEY_SHEET_URL, sheetUrl);
  localStorage.setItem(STORAGE_KEY_MOCK, String(useMock));
};

export const getLaborRate = (): number => parseFloat(localStorage.getItem(STORAGE_KEY_LABOR_RATE) || '12.50');
export const setLaborRate = (rate: number) => localStorage.setItem(STORAGE_KEY_LABOR_RATE, rate.toString());
export const getRawMaterialRate = (): number => parseFloat(localStorage.getItem(STORAGE_KEY_RAW_RATE) || '8.00');
export const setRawMaterialRate = (rate: number) => localStorage.setItem(STORAGE_KEY_RAW_RATE, rate.toString());

const cleanFirestoreData = <T>(data: T): T => JSON.parse(JSON.stringify(data));
const getUserCollection = (collectionName: string) => db.collection(collectionName);
const getUserDoc = (collectionName: string, docId: string) => db.collection(collectionName).doc(docId);

// ============================================================================
// CORE DATA SERVICES
// ============================================================================

export const getUserRole = async (): Promise<string> => {
  const user = auth.currentUser;
  if (!user) return 'GUEST';
  try {
    const snap = await db.collection('user_roles').doc(user.uid).get();
    return snap.exists ? (snap.data()?.role || 'GUEST') : 'GUEST';
  } catch (error) { return 'GUEST'; }
};

// --- CUSTOMERS (CRM) ---

let mockCustomers: Customer[] = [];

export const getCustomers = async (forceRemote = false): Promise<ApiResponse<Customer[]>> => {
  try {
    const snap = await db.collection('customers').get();
    const data = snap.docs.map(d => d.data() as Customer);
    mockCustomers = data; // Sync local cache
    return { success: true, data };
  } catch (e) {
    console.warn("Using local customer cache due to permissions/connection.");
    return { success: true, data: mockCustomers };
  }
};

export const addCustomer = async (customer: Customer): Promise<ApiResponse<Customer>> => {
  const docRef = db.collection('customers').doc(customer.id);
  await docRef.set(cleanFirestoreData(customer));
  if (!mockCustomers.find(c => c.id === customer.id)) mockCustomers.push(customer);
  return { success: true, data: customer };
};

export const updateCustomer = async (id: string, updates: Partial<Customer>): Promise<boolean> => {
    try {
        await db.collection('customers').doc(id).set(updates, { merge: true });
        const idx = mockCustomers.findIndex(c => c.id === id);
        if (idx !== -1) mockCustomers[idx] = { ...mockCustomers[idx], ...updates };
        return true;
    } catch (e) { return false; }
};

export const getCustomerStats = async (customerId: string) => {
    const salesRes = await getSales();
    const customerSales = (salesRes.data || []).filter(s => s.customerId === customerId);
    const totalSpent = customerSales.reduce((sum, s) => sum + s.totalAmount, 0);
    const orderCount = customerSales.length;
    const lastOrder = [...customerSales].sort((a,b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime())[0];
    return { 
        totalSpent, 
        orderCount, 
        lastOrderDate: lastOrder ? lastOrder.dateCreated : 'Never',
        salesHistory: [...customerSales].sort((a,b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime())
    };
};

// --- SALES & ORDERS ---

let mockSales: SalesRecord[] = [];

export const getSales = async (forceRemote = false): Promise<ApiResponse<SalesRecord[]>> => {
  try {
    const snap = await db.collection('sales').orderBy('dateCreated', 'desc').get();
    const data = snap.docs.map(d => d.data() as SalesRecord);
    mockSales = data;
    return { success: true, data };
  } catch (e) { return { success: true, data: mockSales }; }
};

export const createSale = async (customerId: string, items: any[], paymentMethod: PaymentMethod, initialStatus: SalesStatus = 'INVOICED'): Promise<ApiResponse<SalesRecord>> => {
  const customerRes = await getCustomers();
  const customer = (customerRes.data || []).find(c => c.id === customerId);
  
  const newSale: SalesRecord = {
    id: `SALE-${Date.now()}`,
    invoiceId: `INV-${Math.floor(Math.random() * 100000)}`,
    customerId,
    customerName: customer ? customer.name : 'Unknown',
    items,
    totalAmount: items.reduce((sum, i) => sum + (i.quantity * i.unitPrice), 0),
    paymentMethod,
    status: initialStatus,
    dateCreated: new Date().toISOString()
  };

  await db.collection('sales').doc(newSale.id).set(cleanFirestoreData(newSale));
  return { success: true, data: newSale };
};

export const submitOnlineOrder = async (customerName: string, customerPhone: string, customerEmail: string, customerAddress: string, cartItems: { item: FinishedGood, qty: number }[]): Promise<ApiResponse<string>> => {
    const newSaleId = `ORDER-${Date.now()}`;
    let customerId = 'GUEST';
    
    try {
        const customersRef = db.collection('customers');
        let existingDoc = null;
        let existingData = null;

        if (customerEmail) {
            const emailSnap = await customersRef.where('email', '==', customerEmail).limit(1).get();
            if (!emailSnap.empty) { existingDoc = emailSnap.docs[0]; existingData = existingDoc.data() as Customer; }
        }

        if (!existingDoc && customerPhone) {
            const phoneSnap = await customersRef.where('contact', '==', customerPhone).limit(1).get();
            if (!phoneSnap.empty) { existingDoc = phoneSnap.docs[0]; existingData = existingDoc.data() as Customer; }
        }

        if (existingDoc && existingData) {
            customerId = existingData.id;
            const updates: Partial<Customer> = {};
            if (!existingData.type) updates.type = 'B2C';
            if (!existingData.address && customerAddress) updates.address = customerAddress;
            if (Object.keys(updates).length > 0) {
                try { await existingDoc.ref.update(updates); } catch(e) { console.warn("Public profile update restricted."); }
            }
        } else {
            const newId = `cust-shop-${Date.now()}`;
            const newCust: Customer = { 
                id: newId, name: customerName, email: customerEmail, contact: customerPhone, 
                address: customerAddress, name: customerName, type: 'B2C', status: 'ACTIVE', joinDate: new Date().toISOString() 
            };
            
            try {
                await customersRef.doc(newId).set(cleanFirestoreData(newCust));
                customerId = newId;
            } catch (e) {
                console.warn("Public profile creation restricted (Firebase Rules). Proceeding as Guest.");
                customerId = `GUEST-${Date.now()}`;
            }
        }
    } catch (e) { console.error("CRM Auto-link error:", e); }

    const saleRecord: SalesRecord = {
        id: newSaleId, invoiceId: `WEB-${Math.floor(Math.random() * 10000)}`, 
        customerId, customerName, customerPhone, customerEmail, shippingAddress: customerAddress, 
        items: cartItems.map(c => ({ 
            finishedGoodId: c.item.id, recipeName: c.item.recipeName, 
            packagingType: c.item.packagingType, quantity: c.qty, unitPrice: c.item.sellingPrice 
        })), 
        totalAmount: cartItems.reduce((sum, c) => sum + (c.item.sellingPrice * c.qty), 0), 
        paymentMethod: 'COD', status: 'QUOTATION', dateCreated: new Date().toISOString()
    };
    
    try { 
        await db.collection('sales').doc(newSaleId).set(cleanFirestoreData(saleRecord)); 
        return { success: true, data: saleRecord.invoiceId }; 
    } catch (e: any) { return { success: false, message: e.message }; }
};

export const updateSaleStatus = async (saleId: string, status: SalesStatus, additionalData?: any): Promise<ApiResponse<SalesRecord>> => {
  await db.collection('sales').doc(saleId).update(cleanFirestoreData({ status, ...additionalData }));
  return { success: true };
};

// --- PRODUCTION & COSTS ---

export const getDailyProductionCosts = async (forceRemote = false): Promise<ApiResponse<DailyCostMetrics[]>> => {
  try {
    const snap = await db.collection('daily_costs').orderBy('date', 'desc').get();
    const data = snap.docs.map(d => d.data() as DailyCostMetrics);
    return { success: true, data };
  } catch (e) { return { success: false, message: "Failed to fetch costs" }; }
};

export const updateDailyCost = async (id: string, updates: Partial<DailyCostMetrics>): Promise<ApiResponse<boolean>> => {
    await db.collection('daily_costs').doc(id).update(cleanFirestoreData(updates));
    return { success: true };
};

export const getWeeklyRevenue = async (): Promise<{date: string, amount: number}[]> => {
    const salesRes = await getSales();
    const revenueMap: Record<string, number> = {};
    const today = new Date();
    for(let i=6; i>=0; i--) { const d = new Date(today); d.setDate(today.getDate() - i); revenueMap[d.toISOString().split('T')[0]] = 0; }
    (salesRes.data || []).forEach(s => { 
        const date = s.dateCreated.split('T')[0]; 
        if (revenueMap[date] !== undefined && s.status === 'PAID') revenueMap[date] += s.totalAmount; 
    });
    return Object.keys(revenueMap).map(date => ({ date, amount: revenueMap[date] }));
};

// --- INVENTORY & BATCHES ---

export const fetchBatches = async (): Promise<ApiResponse<MushroomBatch[]>> => {
  const snap = await db.collection('batches').orderBy('dateReceived', 'desc').get();
  return { success: true, data: snap.docs.map(d => d.data() as MushroomBatch) };
};

export const updateBatchStatus = async (id: string, status: BatchStatus, updates: any = {}): Promise<ApiResponse<MushroomBatch>> => {
  await db.collection('batches').doc(id).update(cleanFirestoreData({ status, ...updates }));
  return { success: true };
};

export const getInventory = async (): Promise<ApiResponse<InventoryItem[]>> => {
  const snap = await db.collection('inventory').get();
  return { success: true, data: snap.docs.map(d => d.data() as InventoryItem) };
};

export const addInventoryItem = async (item: InventoryItem) => {
  await db.collection('inventory').doc(item.id).set(cleanFirestoreData(item));
  return { success: true };
};

export const deleteInventoryItem = async (id: string) => {
  await db.collection('inventory').doc(id).delete();
  return { success: true };
};

// --- REMAINING UTILS ---

export const getFinishedGoods = async (forceRemote = false) => {
  const snap = await db.collection('finished_goods').orderBy('datePacked', 'desc').get();
  return { success: true, data: snap.docs.map(d => d.data() as FinishedGood) };
};

// Added ApiResponse return type and error handling
export const updateFinishedGoodImage = async (recipeName: string, packagingType: string, file: File): Promise<ApiResponse<void>> => {
    try {
        const storageRef = storage.ref(`products/${Date.now()}_${file.name}`);
        await storageRef.put(file);
        const imageUrl = await storageRef.getDownloadURL();
        const snap = await db.collection('finished_goods').where('recipeName', '==', recipeName).where('packagingType', '==', packagingType).get();
        await Promise.all(snap.docs.map(d => d.ref.update({ imageUrl })));
        return { success: true };
    } catch (error: any) {
        return { success: false, message: error.message || 'Failed to update image' };
    }
};

export const updateFinishedGoodPrice = async (recipeName: string, packagingType: string, sellingPrice: number) => {
    const snap = await db.collection('finished_goods').where('recipeName', '==', recipeName).where('packagingType', '==', packagingType).get();
    await Promise.all(snap.docs.map(d => d.ref.update({ sellingPrice })));
    return { success: true };
};

export const getRecipes = async () => {
    const snap = await db.collection('recipes').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as Recipe));
};

export const saveRecipe = async (recipe: Recipe, file?: File) => {
    await db.collection('recipes').doc(recipe.id).set(cleanFirestoreData(recipe));
    return { success: true };
};

export const deleteRecipe = async (id: string) => {
    await db.collection('recipes').doc(id).delete();
    return true;
};

export const getSuppliers = async () => {
  const snap = await db.collection('suppliers').get();
  return { success: true, data: snap.docs.map(d => d.data() as Supplier) };
};

export const addSupplier = async (s: Supplier) => {
    await db.collection('suppliers').doc(s.id).set(cleanFirestoreData(s));
    return { success: true };
};

export const getPurchaseOrders = async () => {
  const snap = await db.collection('purchase_orders').orderBy('dateOrdered', 'desc').get();
  return { success: true, data: snap.docs.map(d => d.data() as PurchaseOrder) };
};

export const createPurchaseOrder = async (itemId: string, qty: number, supplier: string) => {
    const po: PurchaseOrder = { id: `PO-${Date.now()}`, itemId, itemName: 'Item', quantity: qty, packSize: 1, totalUnits: qty, unitCost: 0, totalCost: 0, status: 'ORDERED', dateOrdered: new Date().toISOString(), supplier };
    await db.collection('purchase_orders').doc(po.id).set(cleanFirestoreData(po));
    return { success: true };
};

export const receivePurchaseOrder = async (id: string, qc: boolean) => {
    await db.collection('purchase_orders').doc(id).update({ status: qc ? 'RECEIVED' : 'COMPLAINT', dateReceived: new Date().toISOString() });
    return { success: true };
};

export const complaintPurchaseOrder = async (id: string, reason: string) => {
    await db.collection('purchase_orders').doc(id).update({ status: 'COMPLAINT', complaintReason: reason });
    return { success: true };
};

export const resolveComplaint = async (id: string, res: string) => {
    await db.collection('purchase_orders').doc(id).update({ status: 'RESOLVED', complaintResolution: res });
    return { success: true };
};

export const getMonthlyBudget = async (m: string) => {
    const snap = await db.collection('budgets').doc(m).get();
    if (snap.exists) return { success: true, data: snap.data() as Budget };
    return { success: false };
};

export const setMonthlyBudget = async (b: Budget) => {
    await db.collection('budgets').doc(b.month).set(cleanFirestoreData(b));
    return { success: true };
};

// --- LEGACY SYNC (Optional if using Firestore primary) ---
export const pushFullDatabase = async () => ({ success: true, message: "Data is live on Firestore." });
export const pullFullDatabase = async () => ({ success: true, message: "Data pulled from Firestore." });

// --- THEME ---
export const THEMES: any = { 
    mushroom: { id: 'mushroom', label: 'Mushroom Earth', colors: { '--earth-800': '#292524', '--nature-600': '#16a34a' } } 
};
export const getTheme = () => localStorage.getItem(STORAGE_KEY_THEME) || 'mushroom';
export const applyTheme = (id: string) => { localStorage.setItem(STORAGE_KEY_THEME, id); };

export const createBatch = async (farm: string, raw: number, spoiled: number, farmBatchId?: string, species?: string, flush?: string) => {
    const batch: MushroomBatch = { id: `B-${Date.now()}`, dateReceived: new Date().toISOString(), sourceFarm: farm, rawWeightKg: raw, spoiledWeightKg: spoiled, netWeightKg: raw - spoiled, status: BatchStatus.RECEIVED, species, farmBatchId, flushNumber: flush };
    await db.collection('batches').doc(batch.id).set(cleanFirestoreData(batch));
    return { success: true, data: batch };
};

// Added ApiResponse return type and error handling
export const packRecipeFIFO = async (name: string, weight: number, count: number, type: 'TIN' | 'POUCH'): Promise<ApiResponse<void>> => {
    try {
        const fg: FinishedGood = { id: `FG-${Date.now()}`, batchId: 'FIFO', recipeName: name, packagingType: type, quantity: count, datePacked: new Date().toISOString(), sellingPrice: 15 };
        await db.collection('finished_goods').doc(fg.id).set(cleanFirestoreData(fg));
        return { success: true };
    } catch (error: any) {
        return { success: false, message: error.message || 'Failed to pack recipe' };
    }
};

export const getPackingHistory = async () => {
    const snap = await db.collection('finished_goods').limit(10).orderBy('datePacked', 'desc').get();
    return { success: true, data: snap.docs.map(d => d.data() as FinishedGood) };
};
