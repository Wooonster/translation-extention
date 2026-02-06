import React from 'react'

interface FloatingBoxProps {
  position: { top: number; left: number }
  status: 'idle' | 'counting' | 'loading' | 'success' | 'error'
  result?: string
  progress?: number // 0-100 for countdown
  onClose?: () => void
}

const FloatingBox: React.FC<FloatingBoxProps> = ({ position, status, result, progress = 0, onClose }) => {
  if (status === 'idle') return null

  // 稍微偏移一点，避免遮挡选中文本
  const style = {
    top: position.top + 10,
    left: position.left,
    zIndex: 2147483647, // Max z-index
  }

  return (
    <div 
      className="fixed bg-white shadow-lg rounded-lg border border-gray-200 text-sm text-gray-800 ai-translate-box transition-all duration-200"
      style={style}
    >
      {/* Counting State: Minimal indicator */}
      {status === 'counting' && (
        <div className="p-2 flex items-center gap-2">
           <div className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
           <span className="text-xs text-gray-500">Translating in {Math.max(0, Math.ceil((100 - progress) * 0.03))}s...</span>
        </div>
      )}

      {/* Loading State */}
      {status === 'loading' && (
        <div className="p-3 w-64">
          <div className="animate-pulse flex space-x-4">
            <div className="flex-1 space-y-2 py-1">
              <div className="h-4 bg-gray-200 rounded w-3/4"></div>
              <div className="h-4 bg-gray-200 rounded"></div>
            </div>
          </div>
        </div>
      )}

      {/* Success State */}
      {status === 'success' && (
        <div className="p-4 w-80 max-h-64 overflow-y-auto">
          <div className="flex justify-between items-start mb-2">
            <h3 className="font-semibold text-gray-700 text-xs uppercase tracking-wide">Translation</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="prose prose-sm text-gray-900 leading-relaxed">
            {result}
          </div>
        </div>
      )}

      {/* Error State */}
      {status === 'error' && (
        <div className="p-3 w-64 bg-red-50 border-red-100 rounded-lg">
          <p className="text-red-600">Translation failed. Please try again.</p>
        </div>
      )}
    </div>
  )
}

export default FloatingBox
