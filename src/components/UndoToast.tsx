import { useEffect } from 'react';

interface Props {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export default function UndoToast({ message, onUndo, onDismiss }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 8000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="undo-toast" role="status">
      <span>{message}</span>
      <button onClick={onUndo}>Undo</button>
    </div>
  );
}
