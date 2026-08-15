import { useStore } from '@/state/store';

export function Notifications() {
  const notifications = useStore((state) => state.notifications);
  const dismiss = useStore((state) => state.dismissNotification);

  if (notifications.length === 0) return null;

  return (
    <div className="notifications">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className={`notification ${notification.kind}`}
          role="status"
          onClick={() => dismiss(notification.id)}
        >
          {notification.message}
        </div>
      ))}
    </div>
  );
}
