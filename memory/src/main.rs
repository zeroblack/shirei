mod server;

use rmcp::{transport::stdio, ServiceExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = server::MemoryServer::new(server::Settings::from_env())
        .serve(stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}
