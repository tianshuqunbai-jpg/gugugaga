import Navbar from './Navbar'
import Hero from './Hero'
import Features from './Features'
import Personalities from './Personalities'
import Roadmap from './Roadmap'
import Footer from './Footer'

export default function HomePage({ onStart }) {
  return (
    <>
      <Navbar home onStart={onStart} />
      <main>
        <Hero onStart={onStart} />
        <Features />
        <Personalities onStart={onStart} />
        <Roadmap />
      </main>
      <Footer />
    </>
  )
}
