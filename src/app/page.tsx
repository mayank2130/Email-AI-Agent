import LoginButton from './components/LoginButton';

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-md">
        <h1 className="text-2xl font-bold mb-4">Email Dashboard</h1>
        <p className="mb-4">Please login to access your emails</p>
        <LoginButton />
      </div>
    </div>
  );
}