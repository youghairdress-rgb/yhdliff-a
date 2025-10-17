import { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { getFunctions, httpsCallable } from 'firebase/functions';

const LIFF_ID = "2008029428-DZNnAbNl";
const firebaseConfig = {
  apiKey: "AIzaSyD7f_GTwM7ee6AgMjwCRetyMNlVKDpb3_4",
  authDomain: "yhd-ai.firebaseapp.com",
  projectId: "yhd-ai",
  storageBucket: "yhd-ai.firebasestorage.app",
  messagingSenderId: "757347798313",
  appId: "1:757347798313:web:e64c91b4e8b0e8bfc33b38",
  measurementId: "G-D26PT4FYPR"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, 'asia-northeast1');

const GENDER_OPTIONS = ["女性", "男性", "その他"];
const UPLOAD_ITEMS = [
  { id: 'frontImage', label: '写真：正面', description: '顔がはっきりと写るように' },
  { id: 'sideImage', label: '写真：サイド', description: '横顔と髪の長さがわかるように' },
  { id: 'backImage', label: '写真：バック', description: '後ろ全体の髪型がわかるように' },
  { id: 'frontVideo', label: '動画：正面(3秒)', description: 'ゆっくりと左右に顔を動かす' },
  { id: 'backVideo', label: '動画：バック(3秒)', description: '髪全体の動きがわかるように' },
];

export default function App() {
  const [phase, setPhase] = useState(1);
  const [user, setUser] = useState(null);
  const [liffProfile, setLiffProfile] = useState({ userId: '読み込み中...', displayName: '読み込み中...' });
  const [userName, setUserName] = useState('');
  const [gender, setGender] = useState('女性');
  const [uploads, setUploads] = useState(UPLOAD_ITEMS.reduce((acc, item) => ({ ...acc, [item.id]: { status: 'pending', url: null } }), {}));
  const [diagnosisResult, setDiagnosisResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [generatedImages, setGeneratedImages] = useState({ style_1: null, style_2: null });
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedStyle, setSelectedStyle] = useState('style_1');
  const [adjustmentText, setAdjustmentText] = useState('');
  const fileInputRefs = useRef({});

  useEffect(() => {
    const initializeApp = async () => {
      try {
        // Firebase Authの初期化を先に実行
        onAuthStateChanged(auth, (currentUser) => {
          if (currentUser) {
            setUser(currentUser);
          } else if (!auth.currentUser) {
            signInAnonymously(auth).catch(e => console.error("SignIn Error", e));
          }
        });

        // LIFF SDKがロードされているか確認
        if (!window.liff) {
          console.error("LIFF SDK is not loaded. Check index.html.");
          setLiffProfile({ userId: 'LIFF SDK読込エラー', displayName: 'エラー' });
          return; // SDKがなければここで処理を中断
        }
        
        await window.liff.init({ liffId: LIFF_ID });

        if (window.liff.isInClient() && !window.liff.isLoggedIn()) {
          window.liff.login();
        } else {
          const profile = window.liff.isInClient() ? await window.liff.getProfile() : { userId: 'PC-Browser', displayName: 'テストユーザー' };
          setLiffProfile(profile);
          setUserName(profile.displayName);
        }
      } catch (error) {
        console.error("Initialization failed", error);
        setLiffProfile({ userId: '初期化エラー', displayName: 'エラー' });
      }
    };
    initializeApp();
  }, []);

  const handleSaveProfile = async () => {
    if (!user) return alert("認証情報がありません。");
    const userDocRef = doc(db, "users", user.uid);
    await setDoc(userDocRef, { liffUserId: liffProfile.userId, name: userName, gender }, { merge: true });
    setPhase(3);
  };

  const handleFileUpload = async (itemId, file) => {
    if (!user || !file) return;
    setUploads(prev => ({ ...prev, [itemId]: { ...prev[itemId], status: 'uploading' } }));
    const storageRef = ref(storage, `users/${user.uid}/${itemId}-${file.name}`);
    try {
      const snapshot = await uploadBytes(storageRef, file);
      const url = await getDownloadURL(snapshot.ref);
      setUploads(prev => ({ ...prev, [itemId]: { status: 'completed', url } }));
      await setDoc(doc(db, "users", user.uid), { uploads: { [itemId]: url } }, { merge: true });
    } catch (error) {
      console.error(`Upload Error ${itemId}:`, error);
      setUploads(prev => ({ ...prev, [itemId]: { status: 'pending' } }));
    }
  };

  const handleRequestDiagnosis = async () => {
    setPhase(3.5);
    setErrorMessage('');
    try {
      const generateDiagnosisFunc = httpsCallable(functions, 'generateDiagnosis');
      const result = await generateDiagnosisFunc();
      setDiagnosisResult(result.data);
      setPhase(4);
    } catch (error) {
      console.error("Cloud Function Error:", error);
      setErrorMessage(`AI診断に失敗しました: ${error.message}`);
      setPhase(3);
    }
  };

  const handleGenerateImage = async (styleKey, customPrompt = null) => {
    if (!diagnosisResult || isGenerating) return;
    setIsGenerating(true);
    setErrorMessage('');
    setSelectedStyle(styleKey);
    try {
      let prompt = diagnosisResult.image_generation_prompts[styleKey];
      if (customPrompt) {
        prompt += `, ${customPrompt}`;
      }
      const generateImageFunc = httpsCallable(functions, 'generateImage');
      const result = await generateImageFunc({
        prompt: prompt,
        originalImageUrl: uploads.frontImage.url,
        originalImageMimeType: uploads.frontImage.mimeType,
      });
      const imageUrl = `data:image/png;base64,${result.data.base64Image}`;
      setGeneratedImages(prev => ({ ...prev, [styleKey]: imageUrl }));
    } catch (error) {
      console.error("Image Generation Error:", error);
      setErrorMessage(`画像生成に失敗しました: ${error.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    if (phase === 6 && diagnosisResult && !generatedImages.style_1) {
      handleGenerateImage('style_1');
    }
  }, [phase, diagnosisResult]);

  const allUploadsCompleted = Object.values(uploads).every(item => item.status === 'completed');

  const renderPhase = () => {
    switch (phase) {
      case 1:
        return (
          <div className="text-center">
            <div className="w-40 h-40 bg-teal-200 rounded-full mx-auto flex items-center justify-center mb-6"><span className="text-2xl font-bold text-teal-700">LOGO</span></div>
            <h1 className="text-3xl font-bold text-gray-800">YHD AI Diagnosis</h1>
            <p className="text-teal-600 font-semibold text-lg mt-2">YHD × AI 『似合わせ』診断</p>
            <p className="text-gray-600 mt-4">お客様の『似合う』を実現するために<br />AIが分析し、最適なアドバイスを伝えます！</p>
            <button onClick={() => setPhase(2)} className="mt-8 w-full bg-teal-500 text-white font-bold py-3 px-6 rounded-lg hover:bg-teal-600 transition-colors duration-300 shadow-lg">診断を始める</button>
          </div>
        );
      case 2:
        return (
          <div>
            <h2 className="text-2xl font-bold text-center mb-8 text-gray-800">プロフィール入力</h2>
            <div className="space-y-6">
              <div><label className="font-semibold text-gray-700">LINEユーザーID</label><div className="mt-2 p-3 bg-gray-100 rounded-md text-gray-600">{liffProfile.userId}</div></div>
              <div><label htmlFor="name" className="font-semibold text-gray-700">お名前</label><input type="text" id="name" value={userName} onChange={(e) => setUserName(e.target.value)} className="w-full mt-2 p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-teal-500" /></div>
              <div><label className="font-semibold text-gray-700">性別</label><div className="flex justify-around mt-2">{GENDER_OPTIONS.map(g => (<button key={g} onClick={() => setGender(g)} className={`px-6 py-2 rounded-full text-sm font-semibold transition-colors duration-300 ${gender === g ? 'bg-teal-500 text-white shadow-md' : 'bg-gray-200 text-gray-700'}`}>{g}</button>))}</div></div>
            </div>
            <button onClick={handleSaveProfile} className="mt-10 w-full bg-gray-800 text-white font-bold py-3 px-6 rounded-lg hover:bg-gray-900 transition-colors duration-300 shadow-lg">撮影に進む</button>
          </div>
        );
      case 3:
        return (
          <div>
            {errorMessage && <div className="p-3 mb-4 bg-red-100 text-red-700 border border-red-200 rounded-lg">{errorMessage}</div>}
            <h2 className="text-2xl font-bold text-center mb-6 text-gray-800">写真・動画撮影</h2>
            <p className="text-center text-gray-600 mb-8">AI診断のため、指定されたアングルから撮影してください。</p>
            <div className="space-y-4">{UPLOAD_ITEMS.map(item => (<div key={item.id} className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200"><div className="flex items-center"><div className="text-teal-500 mr-4">{item.label.includes('写真') ? <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg> : <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>}</div><div><p className="font-semibold text-gray-800">{item.label}</p><p className="text-sm text-gray-500">{item.description}</p></div></div><input type="file" accept={item.label.includes('写真') ? 'image/*' : 'video/*'} ref={el => fileInputRefs.current[item.id] = el} onChange={(e) => handleFileUpload(item.id, e.target.files[0])} className="hidden" /><button onClick={() => fileInputRefs.current[item.id].click()} disabled={uploads[item.id].status === 'uploading'} className={`px-4 py-2 rounded-md text-sm font-semibold transition-colors duration-200 ${uploads[item.id].status === 'pending' ? 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50' : uploads[item.id].status === 'uploading' ? 'bg-yellow-400 text-white cursor-not-allowed' : 'bg-green-500 text-white'}`}>{uploads[item.id].status === 'pending' && '撮影する'}{uploads[item.id].status === 'uploading' && 'アップロード中...'}{uploads[item.id].status === 'completed' && '✔︎ 撮影済み'}</button></div>))}</div>
            <button onClick={handleRequestDiagnosis} disabled={!allUploadsCompleted} className="mt-8 w-full bg-gray-800 text-white font-bold py-3 px-6 rounded-lg transition-colors duration-300 shadow-lg disabled:bg-gray-400 disabled:cursor-not-allowed">AI診断をリクエストする</button>
          </div>
        );
      case 3.5:
        return (<div className="text-center"><div className="animate-spin rounded-full h-16 w-16 border-b-2 border-teal-500 mx-auto"></div><h2 className="text-xl font-semibold text-gray-800 mt-6">AIが診断中です</h2><p className="text-gray-600 mt-2">診断リクエストを送信中...</p></div>);
      case 4:
        if (!diagnosisResult) return <div>診断結果を読み込んでいます...</div>;
        return (
          <div className="space-y-6 animate-fade-in">
            <h2 className="text-2xl font-bold text-center mb-6 text-gray-800">AI診断結果</h2>
            {Object.entries(diagnosisResult.analysis).map(([categoryKey, details]) => (<div key={categoryKey} className="p-4 border border-gray-200 rounded-lg"><h3 className="font-bold text-teal-600 capitalize mb-3">{{"face":"顔診断", "skeleton":"骨格診断", "personal_color":"パーソナルカラー診断", "hair":"毛髪診断"}[categoryKey]}</h3><div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">{Object.entries(details).map(([key, value]) => (<div key={key} className="flex justify-between border-b border-gray-100 py-1"><span className="text-gray-600">{key}</span><span className="font-semibold text-gray-800">{String(value)}</span></div>))}</div></div>))}
            <button onClick={() => setPhase(5)} className="mt-8 w-full bg-teal-500 text-white font-bold py-3 px-6 rounded-lg hover:bg-teal-600 transition-colors duration-300 shadow-lg">提案を見る</button>
          </div>
        );
      case 5:
        if (!diagnosisResult) return <div>提案を読み込んでいます...</div>;
        return (
          <div className="space-y-6 animate-fade-in">
            <h2 className="text-2xl font-bold text-center mb-6 text-gray-800">AIパーソナル提案</h2>
            <div><h3 className="text-lg font-bold text-teal-600 mb-3">ヘアスタイル提案</h3><div className="grid grid-cols-2 gap-4">{diagnosisResult.proposals.hairstyles.map((style, i) => (<div key={i} className="p-4 border border-gray-200 rounded-lg text-center"><p className="font-bold text-gray-800">Style {i + 1}</p><p className="text-teal-700 font-semibold my-1">{style.name}</p><p className="text-xs text-gray-600">{style.description}</p></div>))}</div></div>
            <div><h3 className="text-lg font-bold text-teal-600 mb-3">ヘアカラー提案</h3><div className="grid grid-cols-2 gap-4">{diagnosisResult.proposals.hair_colors.map((color, i) => (<div key={i} className="p-4 border border-gray-200 rounded-lg text-center"><p className="font-bold text-gray-800">Color {i + 1}</p><p className="text-teal-700 font-semibold my-1">{color.name}</p><p className="text-xs text-gray-600">{color.description}</p></div>))}</div></div>
            <div className="p-4 bg-teal-50 border border-teal-200 rounded-lg"><h3 className="text-lg font-bold text-teal-600 mb-3">トップスタイリストAIより</h3><p className="text-sm text-gray-700 leading-relaxed">{diagnosisResult.proposals.overall_comment}</p></div>
            <button onClick={() => setPhase(6)} className="mt-8 w-full bg-gray-800 text-white font-bold py-3 px-6 rounded-lg hover:bg-gray-900 transition-colors duration-300 shadow-lg">合成画像シミュレーションへ</button>
          </div>
        );
      case 6:
        return (
          <div className="space-y-6 animate-fade-in">
            <h2 className="text-2xl font-bold text-center mb-6 text-gray-800">合成画像シミュレーション</h2>
            <div className="flex border-b"><button onClick={() => handleGenerateImage('style_1')} className={`flex-1 py-2 text-center font-semibold ${selectedStyle === 'style_1' ? 'border-b-2 border-teal-500 text-teal-600' : 'text-gray-500'}`}>Style 1</button><button onClick={() => handleGenerateImage('style_2')} className={`flex-1 py-2 text-center font-semibold ${selectedStyle === 'style_2' ? 'border-b-2 border-teal-500 text-teal-600' : 'text-gray-500'}`}>Style 2</button></div>
            <div className="w-full aspect-square bg-gray-200 rounded-lg flex items-center justify-center overflow-hidden">
              {isGenerating ? (<div className="text-center"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-500 mx-auto"></div><p className="text-gray-600 mt-4">画像を生成中...</p></div>) : (generatedImages[selectedStyle] ? <img src={generatedImages[selectedStyle]} alt={`Generated Style ${selectedStyle}`} className="w-full h-full object-cover" /> : <p className="text-gray-500">ここに合成画像が表示されます</p>)}
            </div>
            {errorMessage && <div className="p-3 bg-red-100 text-red-700 border border-red-200 rounded-lg">{errorMessage}</div>}
            <div><label className="font-semibold text-gray-700">画像の微調整</label><p className="text-xs text-gray-500 mb-2">「もう少し明るく」「前髪を短く」など、ご要望を伝えて画像を調整できます。</p><div className="flex space-x-2"><input type="text" value={adjustmentText} onChange={(e) => setAdjustmentText(e.target.value)} placeholder="例：もう少し髪を明るくし" className="flex-grow mt-1 p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-teal-500" /><button onClick={() => handleGenerateImage(selectedStyle, adjustmentText)} disabled={isGenerating} className="bg-gray-800 text-white font-semibold px-4 rounded-md hover:bg-gray-900 disabled:bg-gray-400">反映する</button></div></div>
            <div className="flex flex-col space-y-3 pt-4">
              <a href={generatedImages[selectedStyle]} download={`style-${selectedStyle}.png`} className={`w-full text-center bg-teal-500 text-white font-bold py-3 px-6 rounded-lg hover:bg-teal-600 shadow-lg ${!generatedImages[selectedStyle] || isGenerating ? 'opacity-50 pointer-events-none' : ''}`}>この画像を保存</a>
              <button onClick={() => { setPhase(1); setDiagnosisResult(null); setGeneratedImages({style_1: null, style_2: null}); }} className="w-full bg-gray-200 text-gray-700 font-bold py-3 px-6 rounded-lg hover:bg-gray-300">トップに戻る</button>
            </div>
          </div>
        );
      default:
        return <div>読み込み中...</div>;
    }
  };

  return (
    <div className="bg-gray-50 min-h-screen flex items-center justify-center font-sans">
      <div className="w-full max-w-md mx-auto bg-white rounded-2xl shadow-xl p-8 m-4">
        {renderPhase()}
      </div>
    </div>
  );
}

