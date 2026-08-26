import SmashAnalyzer from "@/components/smash-analyzer";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>S</span>
          <span className={styles.brandText}>
            <strong>SmashLab</strong>
            <span>COURT VISION AI</span>
          </span>
        </div>
        <nav className={styles.nav} aria-label="Điều hướng chính">
          <span className={styles.active}>Phân tích live</span>
          <span>Phiên tập</span>
          <span>Kỹ thuật</span>
        </nav>
        <div className={styles.privacy}>
          <i />
          <span>Xử lý trực tiếp trên thiết bị</span>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>Badminton performance intelligence</p>
            <h1>
              Nhìn thấy từng chuyển động.
              <br />
              <em>Nâng cấp cú smash.</em>
            </h1>
          </div>
          <p className={styles.introCopy}>
            Camera nhận diện 33 điểm cơ thể theo thời gian thực, phân tích chuỗi
            chuyển động và phản hồi kỹ thuật ngay trong buổi tập.
          </p>
        </section>

        <SmashAnalyzer />

        <footer className={styles.footer}>
          <span>SmashLab MVP · MediaPipe trên trình duyệt + Python FastAPI</span>
          <span>Chỉ số tốc độ hiện là tương đối và chưa đo tốc độ quả cầu.</span>
        </footer>
      </main>
    </div>
  );
}
