import { X } from 'lucide-react';

export function Modal({ isOpen, onClose, title, children, actions }) {
  if (!isOpen) return null;

  return (
    <div className="modal-wrapper">
      <div className="modal">
        <div className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          {children}
        </div>
        {actions && (
          <div className="modal-foot">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

export default Modal;
