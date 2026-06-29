import { useEffect } from 'react'
import './styles/tokens.css'
import './styles/global.css'
import Shell from './components/Shell'
import { initPersistence } from './store/persist'

export default function App() {
  useEffect(() => {
    void initPersistence()
  }, [])
  return <Shell />
}
