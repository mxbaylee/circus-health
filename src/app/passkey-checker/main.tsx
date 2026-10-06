import { createRoot } from 'react-dom/client';
import RoundApp from './RoundApp';
import '../tokens.css';
import './checker.css';

createRoot(document.getElementById('root')!).render(<RoundApp guided />);
