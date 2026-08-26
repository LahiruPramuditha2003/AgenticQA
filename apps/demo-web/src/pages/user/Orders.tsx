import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api';
import type { Order } from '../../types';

const Orders: React.FC = () => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = async () => {
    try {
      const userOrders = await api.orders.getUserOrders();
      setOrders(userOrders);
    } catch (error) {
      console.error('Failed to load orders:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusClass = (status: Order['status']) => {
    const statusClasses: Record<Order['status'], string> = {
      pending: 'status-pending',
      processing: 'status-processing',
      shipped: 'status-shipped',
      delivered: 'status-delivered',
      cancelled: 'status-cancelled',
    };
    return statusClasses[status] || '';
  };

  if (isLoading) {
    return (
      <div className="orders-loading">
        <div className="loading-spinner"></div>
        <p>Loading orders...</p>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="orders-empty">
        <div className="empty-icon">📦</div>
        <h2>No orders yet</h2>
        <p>When you place orders, they will appear here.</p>
        <Link to="/products" className="btn btn-primary">
          Start Shopping
        </Link>
      </div>
    );
  }

  return (
    <div className="orders-page">
      <h1>My Orders</h1>

      <div className="orders-list">
        {orders.map((order) => (
          <div key={order.id} className="order-card">
            <div className="order-header">
              <div className="order-id-section">
                <span className="order-id">Order #{order.id}</span>
                <span className="order-date">
                  Placed on {new Date(order.createdAt).toLocaleDateString()}
                </span>
              </div>
              <span className={`order-status ${getStatusClass(order.status)}`}>
                {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
              </span>
            </div>

            <div className="order-items">
              {order.items.map((item, index) => (
                <div key={index} className="order-item">
                  <img src={item.image} alt={item.name} />
                  <div className="order-item-info">
                    <Link to={`/products/${item.productId}`} className="item-name">
                      {item.name}
                    </Link>
                    <p className="item-quantity">Quantity: {item.quantity}</p>
                  </div>
                  <div className="order-item-price">
                    ${(item.price * item.quantity).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>

            <div className="order-footer">
              <div className="order-total">
                <span>Total:</span>
                <span className="total-amount">${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="order-actions">
                <Link to={`/account/orders/${order.id}`} className="btn btn-outline">
                  View Details
                </Link>
                {order.status === 'delivered' && (
                  <button className="btn btn-primary">Write Review</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Orders;
