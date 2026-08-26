import type { Product, CartItem, User, Order, Address, Review } from '../types';
import { products, mockUsers, mockOrders, reviews } from './mockData';

// Simulate API delay and optional error
const delay = (ms: number) => new Promise((resolve, reject) => {
  setTimeout(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('SIMULATE_API_ERROR') === 'true') {
      reject(new Error('Simulated API connection error. Please try again.'));
    } else {
      resolve(true);
    }
  }, ms);
});

// Mock API Service
export const api = {
  // Products
  products: {
    getAll: async (params?: {
      category?: string;
      brand?: string;
      minPrice?: number;
      maxPrice?: number;
      rating?: number;
      inStock?: boolean;
      search?: string;
      sort?: string;
      page?: number;
      limit?: number;
    }): Promise<{ products: Product[]; total: number; page: number; totalPages: number }> => {
      await delay(300);
      
      let filtered = [...products];
      
      if (params?.category) {
        filtered = filtered.filter(p => p.category === params.category);
      }
      
      if (params?.brand) {
        filtered = filtered.filter(p => p.brand === params.brand);
      }
      
      if (params?.minPrice !== undefined) {
        filtered = filtered.filter(p => p.price >= (params.minPrice as number));
      }
      
      if (params?.maxPrice !== undefined) {
        filtered = filtered.filter(p => p.price <= (params.maxPrice as number));
      }
      
      if (params?.rating !== undefined) {
        filtered = filtered.filter(p => p.rating >= (params.rating as number));
      }
      
      if (params?.inStock) {
        filtered = filtered.filter(p => p.stock > 0);
      }
      
      if (params?.search) {
        const search = params.search.toLowerCase();
        filtered = filtered.filter(p =>
          p.name.toLowerCase().includes(search) ||
          p.description.toLowerCase().includes(search) ||
          p.brand.toLowerCase().includes(search)
        );
      }
      
      // Sorting
      if (params?.sort) {
        switch (params.sort) {
          case 'price-asc':
            filtered.sort((a, b) => a.price - b.price);
            break;
          case 'price-desc':
            filtered.sort((a, b) => b.price - a.price);
            break;
          case 'rating':
            filtered.sort((a, b) => b.rating - a.rating);
            break;
          case 'newest':
            filtered.sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0));
            break;
          case 'popular':
            filtered.sort((a, b) => b.reviewCount - a.reviewCount);
            break;
        }
      }
      
      // Pagination
      const page = params?.page || 1;
      const limit = params?.limit || 12;
      const total = filtered.length;
      const totalPages = Math.ceil(total / limit);
      
      const start = (page - 1) * limit;
      const end = start + limit;
      const paginatedProducts = filtered.slice(start, end);
      
      return { products: paginatedProducts, total, page, totalPages };
    },
    
    getById: async (id: string): Promise<Product | null> => {
      await delay(200);
      const product = products.find(p => p.id === id);
      return product || null;
    },
    
    getFeatured: async (): Promise<Product[]> => {
      await delay(200);
      return products.filter(p => p.featured).slice(0, 8);
    },
    
    getNew: async (): Promise<Product[]> => {
      await delay(200);
      return products.filter(p => p.isNew).slice(0, 8);
    },
  },
  
  // Categories
  categories: {
    getAll: async () => {
      await delay(200);
      return [
        { id: '1', name: 'Laptops', description: 'Powerful laptops for work, gaming, and creativity', image: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400', productCount: 24 },
        { id: '2', name: 'Smartphones', description: 'Latest smartphones with cutting-edge technology', image: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400', productCount: 32 },
        { id: '3', name: 'Audio', description: 'Premium headphones, earbuds, and speakers', image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400', productCount: 45 },
        { id: '4', name: 'Tablets', description: 'Versatile tablets for productivity and entertainment', image: 'https://images.unsplash.com/photo-1544244015-0df4b3ffc6b0?w=400', productCount: 18 },
        { id: '5', name: 'Wearables', description: 'Smartwatches and fitness trackers', image: 'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=400', productCount: 28 },
        { id: '6', name: 'Gaming', description: 'Consoles, controllers, and gaming accessories', image: 'https://images.unsplash.com/photo-1593118247619-e2d6f056869e?w=400', productCount: 36 },
        { id: '7', name: 'TVs', description: 'Stunning 4K and OLED TVs for home entertainment', image: 'https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?w=400', productCount: 22 },
        { id: '8', name: 'Cameras', description: 'Professional cameras and photography equipment', image: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=400', productCount: 19 },
        { id: '9', name: 'Accessories', description: 'Essential tech accessories and peripherals', image: 'https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=400', productCount: 67 },
      ];
    },
  },
  
  // Cart
  cart: {
    get: async (): Promise<CartItem[]> => {
      await delay(100);
      const cart = localStorage.getItem('techstore_cart');
      return cart ? JSON.parse(cart) : [];
    },
    
    addItem: async (item: Omit<CartItem, 'quantity'>, quantity: number = 1): Promise<CartItem[]> => {
      await delay(100);
      const cart = await api.cart.get();
      const existingIndex = cart.findIndex(i => i.productId === item.productId);
      
      if (existingIndex >= 0) {
        cart[existingIndex].quantity += quantity;
      } else {
        cart.push({ ...item, quantity });
      }
      
      localStorage.setItem('techstore_cart', JSON.stringify(cart));
      return cart;
    },
    
    updateQuantity: async (productId: string, quantity: number): Promise<CartItem[]> => {
      await delay(100);
      const cart = await api.cart.get();
      
      if (quantity <= 0) {
        const filtered = cart.filter(i => i.productId !== productId);
        localStorage.setItem('techstore_cart', JSON.stringify(filtered));
        return filtered;
      }
      
      const item = cart.find(i => i.productId === productId);
      if (item) {
        item.quantity = quantity;
        localStorage.setItem('techstore_cart', JSON.stringify(cart));
      }
      
      return cart;
    },
    
    removeItem: async (productId: string): Promise<CartItem[]> => {
      await delay(100);
      const cart = await api.cart.get();
      const filtered = cart.filter(i => i.productId !== productId);
      localStorage.setItem('techstore_cart', JSON.stringify(filtered));
      return filtered;
    },
    
    clear: async (): Promise<CartItem[]> => {
      await delay(100);
      localStorage.removeItem('techstore_cart');
      return [];
    },
  },
  
  // Auth
  auth: {
    login: async (email: string, password: string): Promise<{ user: User; token: string }> => {
      await delay(500);
      const user = mockUsers.find(u => u.email === email);
      
      if (!user) {
        throw new Error('Invalid email or password');
      }
      
      // Simple password check for demo (in real app, this would be hashed)
      if (password !== 'password123' && email !== 'customer@example.com') {
        // Allow any password for demo purposes
      }
      
      const token = 'mock-jwt-token-' + user.id;
      localStorage.setItem('techstore_token', token);
      localStorage.setItem('techstore_user', JSON.stringify(user));
      
      return { user, token };
    },
    
    register: async (data: { name: string; email: string; password: string }): Promise<{ user: User; token: string }> => {
      await delay(500);
      const existingUser = mockUsers.find(u => u.email === data.email);
      
      if (existingUser) {
        throw new Error('Email already registered');
      }
      
      const newUser: User = {
        id: String(mockUsers.length + 1),
        email: data.email,
        name: data.name,
        role: 'customer',
        createdAt: new Date().toISOString(),
      };
      
      const token = 'mock-jwt-token-' + newUser.id;
      localStorage.setItem('techstore_token', token);
      localStorage.setItem('techstore_user', JSON.stringify(newUser));
      
      return { user: newUser, token };
    },
    
    logout: async (): Promise<void> => {
      await delay(100);
      localStorage.removeItem('techstore_token');
      localStorage.removeItem('techstore_user');
    },
    
    getCurrentUser: async (): Promise<User | null> => {
      await delay(100);
      const userStr = localStorage.getItem('techstore_user');
      const token = localStorage.getItem('techstore_token');
      
      if (!userStr || !token) {
        return null;
      }
      
      return JSON.parse(userStr);
    },
    
    updateProfile: async (data: Partial<User>): Promise<User> => {
      await delay(300);
      const currentUser = await api.auth.getCurrentUser();
      if (!currentUser) {
        throw new Error('Not authenticated');
      }
      
      const updatedUser = { ...currentUser, ...data };
      localStorage.setItem('techstore_user', JSON.stringify(updatedUser));
      
      return updatedUser;
    },
  },
  
  // Orders
  orders: {
    create: async (orderData: {
      items: CartItem[];
      shippingAddress: Address;
      paymentMethod: string;
    }): Promise<Order> => {
      await delay(800);
      
      const currentUser = await api.auth.getCurrentUser();
      if (!currentUser) {
        throw new Error('Not authenticated');
      }
      
      const subtotal = orderData.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const tax = subtotal * 0.08;
      const shipping = subtotal > 100 ? 0 : 9.99;
      const total = subtotal + tax + shipping;
      
      const newOrder: Order = {
        id: 'ORD-' + Date.now(),
        userId: currentUser.id,
        items: orderData.items.map(item => ({
          productId: item.productId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          image: item.image,
        })),
        subtotal: Math.round(subtotal * 100) / 100,
        tax: Math.round(tax * 100) / 100,
        shipping,
        total: Math.round(total * 100) / 100,
        status: 'pending',
        shippingAddress: orderData.shippingAddress,
        paymentMethod: orderData.paymentMethod,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      
      mockOrders.unshift(newOrder);
      await api.cart.clear();
      
      return newOrder;
    },
    
    getUserOrders: async (): Promise<Order[]> => {
      await delay(300);
      const currentUser = await api.auth.getCurrentUser();
      if (!currentUser) {
        return [];
      }
      
      return mockOrders.filter(o => o.userId === currentUser.id);
    },
    
    getById: async (id: string): Promise<Order | null> => {
      await delay(300);
      return mockOrders.find(o => o.id === id) || null;
    },
  },
  
  // Reviews
  reviews: {
    getByProduct: async (productId: string): Promise<Review[]> => {
      await delay(200);
      return reviews.filter(r => r.productId === productId);
    },
    
    addReview: async (data: {
      productId: string;
      rating: number;
      title: string;
      comment: string;
    }): Promise<Review> => {
      await delay(300);
      const currentUser = await api.auth.getCurrentUser();
      
      const newReview: Review = {
        id: String(reviews.length + 1),
        productId: data.productId,
        userId: currentUser?.id || 'anonymous',
        userName: currentUser?.name || 'Anonymous',
        rating: data.rating,
        title: data.title,
        comment: data.comment,
        createdAt: new Date().toISOString().split('T')[0],
        helpful: 0,
      };
      
      reviews.unshift(newReview);
      return newReview;
    },
  },
};

export default api;
